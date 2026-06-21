import { policy, getCategoryConfig, OPD_CATEGORIES, type CategoryKey, type Member } from "./policy";
import { loadClaims } from "./claims-store";

export type RuleResult = { ok: boolean; label: string; detail: string };

export type EligibilityInput = {
  primary: Member;
  claimant: Member;
  category: CategoryKey;
  treatmentDate: string; // YYYY-MM-DD
  amount: number;
  hospital: string;
  inNetwork: boolean;
};

export type EligibilityOutput = {
  rules: RuleResult[];
  passed: boolean;
  approvedAmount: number;
  copay: number;
  networkDiscount: number;
  notes: string[];
  sameDayCount: number;
  sameDayFlagged: boolean;
  // hit: exceeded the policy threshold — informational only, does NOT affect `passed`. The Final Analysis stage routes it to human review.
};

// Sanity ceiling for rule 7 below — NOT the real per-claim cap (that's enforced
// by the Math.min() in the payable calculation further down). This only catches
// obviously mistaken/fraudulent entries far beyond any plausible claim.
const PER_CLAIM_SANITY_MULTIPLIER = 50;

function daysBetween(a: string, b: string) {
  return Math.floor((new Date(b).getTime() - new Date(a).getTime()) / 86400000);
}

export function evaluateEligibility(input: EligibilityInput): EligibilityOutput {
  const rules: RuleResult[] = [];
  const notes: string[] = [];
  const cfg = getCategoryConfig(input.category);
  const today = new Date().toISOString().slice(0, 10);
  const claims = loadClaims(); // one read, reused below — was being re-fetched 3x for one evaluation

  // 1. Policy active
  const active =
    policy.policy_holder.renewal_status === "ACTIVE" &&
    input.treatmentDate >= policy.policy_holder.policy_start_date &&
    input.treatmentDate <= policy.policy_holder.policy_end_date;
  rules.push({
    ok: active,
    label: "Policy active on treatment date",
    detail: `${policy.policy_holder.policy_start_date} → ${policy.policy_holder.policy_end_date}`,
  });

  // 2. Dependent eligibility
  const rel = input.claimant.relationship.toUpperCase();
  const covered = policy.coverage.family_floater.covered_relationships.map((r) => r.toUpperCase());
  const relOk = covered.includes(rel) || (rel === "CHILD" && covered.includes("CHILDREN"));
  rules.push({
    ok: relOk,
    label: "Claimant relationship covered",
    detail: `${input.claimant.name} (${input.claimant.relationship})`,
  });

  // 3. Category covered
  rules.push({
    ok: !!cfg?.covered,
    label: "Category covered under policy",
    detail: cfg ? input.category.replace("_", " ") : `"${input.category}" not configured in policy`,
  });

  // 4. Initial waiting period
  const waitDays = daysBetween(
    input.primary.join_date ?? policy.policy_holder.policy_start_date,
    input.treatmentDate,
  );
  const waitOk = waitDays >= policy.waiting_periods.initial_waiting_period_days;
  rules.push({
    ok: waitOk,
    label: `Initial waiting period (${policy.waiting_periods.initial_waiting_period_days} days)`,
    detail: `${waitDays} days since join date`,
  });

  // 5. Submission deadline
  const sinceTreatment = daysBetween(input.treatmentDate, today);
  const deadlineOk = sinceTreatment <= policy.submission_rules.deadline_days_from_treatment && sinceTreatment >= 0;
  rules.push({
    ok: deadlineOk,
    label: `Submitted within ${policy.submission_rules.deadline_days_from_treatment} days of treatment`,
    detail: sinceTreatment < 0 ? "Treatment date in future" : `${sinceTreatment} days ago`,
  });

  // 6. Minimum amount
  const minOk = input.amount >= policy.submission_rules.minimum_claim_amount;
  rules.push({
    ok: minOk,
    label: `Minimum claim amount ₹${policy.submission_rules.minimum_claim_amount}`,
    detail: `Entered ₹${input.amount.toLocaleString("en-IN")}`,
  });

  // 7. Per-claim limit sanity check — the real ₹ cap is applied later via
  // Math.min(), not here; this just blocks wildly-wrong entries.
  const perClaim = policy.coverage.per_claim_limit;
  const perClaimOk = input.amount <= perClaim * PER_CLAIM_SANITY_MULTIPLIER;
  rules.push({
    ok: perClaimOk,
    label: `Per-claim cap ₹${perClaim.toLocaleString("en-IN")}`,
    detail:
      input.amount > perClaim
        ? `Will be capped at ₹${perClaim.toLocaleString("en-IN")}`
        : "Within cap",
  });

  // 8. Category sub-limit availability — annual category limit minus prior
  // claims this year, pooled across the whole family under this primary member.
  const priorForCategory = claims
    .filter(
      (c) =>
        c.primary_member_id === input.primary.member_id &&
        c.category === input.category &&
        c.status !== "REJECTED" &&
        c.status !== "CANCELLED",
    )
    .reduce((s, c) => s + c.approved_amount, 0);
  const subLimit = cfg?.sub_limit ?? 0;
  const remaining = Math.max(0, subLimit - priorForCategory);
  rules.push({
    ok: remaining > 0,
    label: `${input.category} sub-limit remaining`,
    detail: cfg
      ? `₹${remaining.toLocaleString("en-IN")} of ₹${subLimit.toLocaleString("en-IN")}`
      : "Category not configured in policy",
  });

  // 9. Combined annual OPD limit — a SEPARATE pool from the per-category
  // sub-limit above. policy.coverage.annual_opd_limit caps ALL OPD-type
  // categories together (consultation + diagnostic + ...), pooled across the
  // family under this primary. This was previously not checked at all.
  const opdCategoryKeys = new Set(OPD_CATEGORIES.map((c) => c.key));
  const isOpdCategory = opdCategoryKeys.has(input.category);
  const annualOpdLimit = policy.coverage.annual_opd_limit ?? Infinity;
  const priorOpdTotal = isOpdCategory
    ? claims
        .filter(
          (c) =>
            c.primary_member_id === input.primary.member_id &&
            opdCategoryKeys.has(c.category as CategoryKey) &&
            c.status !== "REJECTED" &&
            c.status !== "CANCELLED",
        )
        .reduce((s, c) => s + c.approved_amount, 0)
    : 0;
  const opdRemaining = isOpdCategory ? Math.max(0, annualOpdLimit - priorOpdTotal) : Infinity;
  if (isOpdCategory) {
    rules.push({
      ok: opdRemaining > 0,
      label: "Annual OPD limit remaining",
      detail: `₹${opdRemaining.toLocaleString("en-IN")} of ₹${annualOpdLimit.toLocaleString("en-IN")}`,
    });
  }

  // 10. Duplicate claim detection (same claimant, category, date, amount)
  const dup = claims.find(
    (c) =>
      c.claimant_id === input.claimant.member_id &&
      c.category === input.category &&
      c.treatment_date === input.treatmentDate &&
      Math.abs(c.amount - input.amount) < 1 &&
      c.status !== "CANCELLED",
  );
  rules.push({
    ok: !dup,
    label: "No duplicate claim detected",
    detail: dup ? `Matches existing claim ${dup.id}` : "Unique submission",
  });

  // `passed` is computed here — BEFORE the same-day rule below — so a flagged
  // same-day pattern never blocks eligibility on its own. It still shows up in
  // the rule list for transparency; it's just not a gate.
  const passed = rules.every((r) => r.ok);

  // 11. Same-day fraud threshold — informational. A flagged pattern is
  // surfaced via sameDayCount/sameDayFlagged and handled downstream by the
  // Final Analysis stage (human review), not blocked here.
  const sameDayCount = claims.filter(
    (c) => c.submitted_at.slice(0, 10) === today && c.primary_member_id === input.primary.member_id,
  ).length;
  const sameDayFlagged = sameDayCount >= policy.fraud_thresholds.same_day_claims_limit;
  rules.push({
    ok: !sameDayFlagged,
    label: `Daily submission limit (${policy.fraud_thresholds.same_day_claims_limit})`,
    detail: sameDayFlagged
      ? `${sameDayCount} submitted today — flagged for human review at final analysis, not blocked here`
      : `${sameDayCount} submitted today`,
  });

  // Payable: cap first (per-claim limit, category sub-limit, combined OPD
  // pool) — THEN network discount — THEN co-pay on what's left after discount.

  // Debugging for amount
  console.log(`DEBUG: passed=${passed}`);
  console.log(`DEBUG: input.amount=${input.amount}`);
  console.log(`DEBUG: perClaim=${perClaim}`);
  console.log(`DEBUG: remaining=${remaining}`);
  console.log(`DEBUG: opdRemaining=${opdRemaining}`);

  let payable = Math.min(input.amount, perClaim, remaining, opdRemaining);

  console.log(`DEBUG: payable after min=${payable}`);

  const networkDiscount = input.inNetwork
    ? Math.round((payable * (cfg?.network_discount_percent ?? 0)) / 100)
    : 0;
  payable -= networkDiscount;
  const copay = Math.round((payable * (cfg?.copay_percent ?? 0)) / 100);

  console.log(`DEBUG: copay=${copay}`);

  // const approvedAmount = passed ? Math.max(0, payable - copay) : 0;
  const approvedAmount = Math.max(0, payable - copay);


  console.log(`DEBUG: approvedAmount=${approvedAmount}`);

  if (input.inNetwork && networkDiscount > 0) {
    notes.push(`Network discount of ₹${networkDiscount.toLocaleString("en-IN")} applied.`);
  }
  if (copay > 0)
    notes.push(
      `Co-pay of ${cfg?.copay_percent ?? 0}% (₹${copay.toLocaleString("en-IN")}) deducted.`,
    );
  if (input.amount > perClaim) notes.push(`Claim capped at per-claim limit ₹${perClaim.toLocaleString("en-IN")}.`);
  if (input.amount > remaining)
    notes.push(
      `Claim capped at remaining ${input.category} sub-limit ₹${remaining.toLocaleString("en-IN")}.`,
    );
  if (isOpdCategory && input.amount > opdRemaining)
    notes.push(
      `Claim capped at remaining annual OPD limit ₹${opdRemaining.toLocaleString("en-IN")}.`,
    );
  if (input.amount >= policy.fraud_thresholds.high_value_claim_threshold)
    notes.push(`High-value claim — routed to manual review.`);

  return {
    rules,
    passed,
    approvedAmount,
    copay,
    networkDiscount,
    notes,
    sameDayCount,
    sameDayFlagged,
  };
}
