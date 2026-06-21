import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  getMember,
  getBeneficiaries,
  getCategoryConfig,
  OPD_CATEGORIES,
  DOCUMENT_TYPES,
  policy,
  type Member,
  type CategoryKey,
} from "@/lib/policy";
import { evaluateEligibility, type EligibilityOutput } from "@/lib/eligibility";
import { saveClaim, type StoredClaim, type DocVerification } from "@/lib/claims-store";
import {
  decideFromResult,
  getEndpoint,
  setEndpoint,
  mapCategoryToApi,
  verifyDocument,
  type DocDecision,
} from "@/lib/doc-verify";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  Check,
  Lock,
  AlertCircle,
  Upload,
  FileText,
  X,
  ShieldCheck,
  ShieldAlert,
  Loader2,
  BadgeCheck,
  Ticket,
  RefreshCw,
  Eye,
  ChevronDown,
  ChevronUp,
} from "lucide-react";

import {
  getFinalAnalysisEndpoint,
  setFinalAnalysisEndpoint,
  runFinalAnalysis as requestFinalAnalysis,
  decideFinalOutcome,
} from "@/lib/final-analysis";

import { cn } from "@/lib/utils";

type StageId = "member" | "claim" | "eligibility" | "documents" | "analysis" | "review";

const STAGES: { id: StageId; title: string; subtitle: string }[] = [
  { id: "member", title: "Member & Beneficiary", subtitle: "Identify who the claim is for" },
  { id: "claim", title: "Claim Details", subtitle: "Treatment, provider & amount" },
  { id: "eligibility", title: "Eligibility Check", subtitle: "Policy rules evaluation" },
  { id: "documents", title: "Supporting Documents", subtitle: "AI-verified per document" },
  { id: "analysis", title: "Final Analysis", subtitle: "Fraud check & AI confidence review" },
  { id: "review", title: "Review & Submit", subtitle: "Confirm and file claim" },
];

const HOSPITAL_OTHER = "__OTHER__";
const MAX_DOC_ATTEMPTS = 3;

type FinalAnalysisState = {
  status: "idle" | "running" | "done" | "error";
  fraudFlagged: boolean;
  sameDayCount: number;
  confidence?: number;
  outcome?: "SUCCESS" | "HUMAN_REVIEW";
  error?: string;
};

type DocState = {
  file: File | null;
  attempts: number;
  status: "idle" | "uploading" | "approved" | "failed" | "review" | "error" | "unprocessable";
  confidence?: number;
  reasoning?: string;
  error?: string;
};

const emptyDoc = (): DocState => ({ file: null, attempts: 0, status: "idle" });

export function ClaimWizard({
  ticket,
  onSubmitted,
  onCancelClaim,
}: {
  ticket: string;
  onSubmitted: (claim: StoredClaim) => void;
  onCancelClaim?: () => void; // fired after resetAll() — wired this to get a fresh ticket ID per cancel
}) {
  const [current, setCurrent] = useState<StageId>("member");

  const [locked, setLocked] = useState<Record<StageId, boolean>>({
    member: false,
    claim: false,
    eligibility: false,
    documents: false,
    analysis: false,
    review: false,
  });

  // Stage 1
  const [memberIdInput, setMemberIdInput] = useState("");
  const [primary, setPrimary] = useState<Member | null>(null);
  const [claimantId, setClaimantId] = useState("");
  const beneficiaries = useMemo(() => (primary ? getBeneficiaries(primary.member_id) : []), [primary]);
  const claimant = beneficiaries.find((b) => b.member_id === claimantId) ?? null;

  // Stage 2
  const [category, setCategory] = useState<CategoryKey | "">("");
  const [treatmentDate, setTreatmentDate] = useState("");
  const [amount, setAmount] = useState("");
  const [hospitalChoice, setHospitalChoice] = useState<string>(""); // network value or HOSPITAL_OTHER
  const [hospitalOther, setHospitalOther] = useState("");
  const hospital = hospitalChoice === HOSPITAL_OTHER ? hospitalOther.trim() : hospitalChoice;
  const inNetwork = !!hospitalChoice && hospitalChoice !== HOSPITAL_OTHER;

  // ---- ADMIN OVERRIDE (plug-in, may be removed in later iterations) ----
  const [adminOverride, setAdminOverride] = useState<"YES" | "NO">("NO");
  // ---- END ADMIN OVERRIDE ----

  // Stage 2 verification gate
  const [verifyResult, setVerifyResult] = useState<EligibilityOutput | null>(null);
  const [verifying, setVerifying] = useState(false);

  // Stage 3
  const [eligibility, setEligibility] = useState<EligibilityOutput | null>(null);

  // Stage 4
  const [docs, setDocs] = useState<Record<string, DocState>>({});
  const inFlightRef = useRef<Set<string>>(new Set());
  const reqTokenRef = useRef<Record<string, number>>({});
  const [endpoint, setEndpointState] = useState<string>("");

  const docReq = category ? (policy.document_requirements as any)[category.toUpperCase()] : null;
  const allDocTypes: string[] = docReq ? [...docReq.required, ...docReq.optional] : [];

  // Stage 5 — Final Analysis
  const [finalAnalysisEndpoint, setFinalAnalysisEndpointState] = useState<string>("");
  useEffect(() => {
    setFinalAnalysisEndpointState(getFinalAnalysisEndpoint());
  }, []);
  const [finalAnalysis, setFinalAnalysis] = useState<FinalAnalysisState | null>(null);
  const [showLogs, setShowLogs] = useState(false);

  function lookupMember() {
    const m = getMember(memberIdInput.trim());
    if (!m) {
      toast.error("Member ID not found in database.");
      setPrimary(null);
      return;
    }
    if (m.relationship !== "SELF") {
      toast.error("Please enter the Primary (Employee) Member ID, not a dependent ID.");
      return;
    }
    setPrimary(m);
    setClaimantId("");
    toast.success(`Member verified: ${m.name}`);
  }

  function submitStage(stage: StageId) {
    if (stage === "member") {
      if (!primary || !claimantId) return toast.error("Select a primary member and a claimant.");
      setLocked((l) => ({ ...l, member: true }));
      setCurrent("claim");
    } else if (stage === "claim") {
      if (!verifyResult || !verifyResult.passed) {
        return toast.error("Please run Verify and resolve all checks before continuing.");
      }
      setLocked((l) => ({ ...l, claim: true }));
      setEligibility(verifyResult);
      setCurrent("eligibility");
    } else if (stage === "eligibility") {
      if (!eligibility?.passed)
        return toast.error("Resolve failing rules before proceeding. You may cancel and restart.");
      setLocked((l) => ({ ...l, eligibility: true }));
      setCurrent("documents");
    } else if (stage === "documents") {
      const required: string[] = docReq?.required ?? [];
      const notReady = required.filter((t) => {
        const d = docs[t];
        return !d || d.status === "idle" || d.status === "uploading" || d.status === "error";
      });
      if (notReady.length)
        return toast.error(
          `Verify all required documents first: ${notReady.map((t) => DOCUMENT_TYPES[t] ?? t).join(", ")}`,
        );
      setLocked((l) => ({ ...l, documents: true }));
      setCurrent("analysis");
    } else if (stage === "analysis") {
      if (!finalAnalysis || finalAnalysis.status !== "done") {
        return toast.error("Run final analysis before continuing.");
      }
      setLocked((l) => ({ ...l, analysis: true }));
      setCurrent("review");
    }
  }

  // ---- ADMIN OVERRIDE helper ----
  function isDateRule(label: string) {
    const l = label.toLowerCase();
    return (
      l.includes("policy active") || l.includes("waiting period") || l.includes("submitted within")
    );
  }
  function applyOverride(result: EligibilityOutput): EligibilityOutput {
    if (adminOverride !== "YES") return result;
    const rules = result.rules.map((r) =>
      !r.ok && isDateRule(r.label) ? { ...r, ok: true, detail: `${r.detail} · overridden by admin` } : r,
    );
    const passed = rules.every((r) => r.ok);
    return { ...result, rules, passed };
  }
  // ---- END ADMIN OVERRIDE helper ----

  function runVerify() {
    const amt = Number(amount);
    if (!category) return toast.error("Select a claim category.");
    if (!treatmentDate) return toast.error("Enter treatment date.");
    if (!amt || amt <= 0) return toast.error("Enter a valid amount.");
    if (!hospital.trim()) return toast.error("Enter provider name.");
    setVerifying(true);
    setTimeout(() => {
      const raw = evaluateEligibility({
        primary: primary!,
        claimant: claimant!,
        category: category as CategoryKey,
        treatmentDate,
        amount: amt,
        hospital,
        inNetwork,
      });
      const result = applyOverride(raw);
      setVerifyResult(result);
      setVerifying(false);
      if (result.passed) toast.success("All checks passed. You may now continue.");
      else {
        const failed = result.rules.filter((r) => !r.ok).map((r) => r.label).join("; ");
        toast.error(`Verification failed: ${failed}`);
      }
    }, 400);
  }

  function invalidateVerify() {
    if (verifyResult) setVerifyResult(null);
  }

  // Upload + verify a single document against the langgraph endpoint.
  async function uploadDoc(type: string, file: File) {
    if (!endpoint) {
      toast.error("Set the verification endpoint URL first.");
      return;
    }
    if (file.size > 5 * 1024 * 1024) return toast.error(`${file.name} exceeds 5MB limit.`);
    const ok = ["application/pdf", "image/jpeg", "image/png"].includes(file.type);
    if (!ok) return toast.error("Only PDF, JPG, or PNG accepted.");

    const prev = docs[type] ?? emptyDoc();
    if (prev.status === "approved") return; // locked
    if (prev.status === "unprocessable" || prev.attempts >= MAX_DOC_ATTEMPTS) {
      setDocs((d) => ({ ...d, [type]: { ...(d[type] ?? prev), status: "unprocessable" } }));
      return toast.error(`Max ${MAX_DOC_ATTEMPTS} attempts reached — this document is unprocessable.`);
    }
    if (inFlightRef.current.has(type)) return; // double-click guard: a request for this slot is already running

    const attempt = prev.attempts + 1;
    const myToken = (reqTokenRef.current[type] ?? 0) + 1;
    reqTokenRef.current[type] = myToken;
    inFlightRef.current.add(type);

    setDocs((d) => ({
      ...d,
      [type]: {
        ...prev,
        file,
        attempts: attempt,
        status: "uploading",
        error: undefined,
        confidence: undefined,
        reasoning: undefined,
      },
    }));

    try {
      const resp = await verifyDocument({
        endpoint,
        file,
        patient_name: claimant?.name ?? "",
        claim_category: mapCategoryToApi(category as CategoryKey),
        treatment_date: treatmentDate,
        claimed_amt: Number(amount),
      });
      if (reqTokenRef.current[type] !== myToken) return; // superseded by a clear/retry — drop this response

      const decision: DocDecision = decideFromResult(resp.processing_result);
      const cappedOut = attempt >= MAX_DOC_ATTEMPTS && decision !== "APPROVED";
      const status =
        decision === "APPROVED" ? "approved" : cappedOut ? "unprocessable" : decision === "FAILED" ? "failed" : "review";

      setDocs((d) => ({
        ...d,
        [type]: {
          file,
          attempts: attempt,
          status,
          confidence: resp.processing_result.confidence_score,
          reasoning: resp.processing_result.reasoning,
        },
      }));

      if (status === "approved") toast.success(`${DOCUMENT_TYPES[type] ?? type} verified.`);
      else if (status === "unprocessable")
        toast.error(`${DOCUMENT_TYPES[type] ?? type} could not be verified after ${MAX_DOC_ATTEMPTS} attempts. Marked unprocessable.`);
      else if (status === "failed")
        toast.error(
          `${DOCUMENT_TYPES[type] ?? type} failed (${MAX_DOC_ATTEMPTS - attempt} retr${MAX_DOC_ATTEMPTS - attempt === 1 ? "y" : "ies"} left).`,
        );
      else toast(`${DOCUMENT_TYPES[type] ?? type} flagged for human review.`);
    } catch (e: any) {
      if (reqTokenRef.current[type] !== myToken) return; // superseded — drop
      const cappedOut = attempt >= MAX_DOC_ATTEMPTS;
      setDocs((d) => ({
        ...d,
        [type]: { ...prev, file, attempts: attempt, status: cappedOut ? "unprocessable" : "error", error: e?.message ?? "Upload failed" },
      }));
      toast.error(
        cappedOut
          ? `Verification error on final attempt — ${DOCUMENT_TYPES[type] ?? type} marked unprocessable.`
          : `Verification error: ${e?.message ?? "unknown"}`,
      );
    } finally {
      inFlightRef.current.delete(type);
    }
  }

  function clearDoc(type: string) {
    setDocs((d) => {
      const prev = d[type] ?? emptyDoc();
      if (prev.status === "approved" || prev.status === "unprocessable") return d; // terminal, not clearable
      reqTokenRef.current[type] = (reqTokenRef.current[type] ?? 0) + 1; // invalidate any in-flight response for this slot
      return { ...d, [type]: { ...emptyDoc(), attempts: prev.attempts } };
    });
  }

  async function runFinalAnalysisStage() {
    if (!eligibility || !primary || !claimant || !category) return;

    // Fraud check first — instant, reuses the count already computed during
    // eligibility verification. No new claims can have been saved since then
    // (saveClaim only runs in finalSubmit), so this is still accurate here.
    if (eligibility.sameDayFlagged) {
      setFinalAnalysis({
        status: "done",
        fraudFlagged: true,
        sameDayCount: eligibility.sameDayCount,
        outcome: "HUMAN_REVIEW",
      });
      toast(`Unusual same-day claim pattern — flagged for human review.`);
      return;
    }

    if (!finalAnalysisEndpoint) {
      toast.error("Set the final analysis endpoint URL first.");
      return;
    }

    setFinalAnalysis({
      status: "running",
      fraudFlagged: false,
      sameDayCount: eligibility.sameDayCount,
    });
    try {
      const resp = await requestFinalAnalysis({
        endpoint: finalAnalysisEndpoint,
        patient_name: claimant.name,
        claim_category: mapCategoryToApi(category as CategoryKey),
        treatment_date: treatmentDate,
        claimed_amt: Number(amount),
        approved_amount: eligibility.approvedAmount,
        hospital,
        in_network: inNetwork,
        documents: allDocTypes
          .filter((t) => !!docs[t]?.file)
          .map((t) => {
            const d = docs[t]!;
            return {
              type: t,
              decision: d.status,
              confidence: d.confidence,
              reasoning: d.reasoning,
            };
          }),
      });
      const outcome = decideFinalOutcome(resp.confidence_score);
      setFinalAnalysis({
        status: "done",
        fraudFlagged: false,
        sameDayCount: eligibility.sameDayCount,
        confidence: resp.confidence_score,
        outcome,
      });
      if (outcome === "SUCCESS")
        toast.success(
          `Final analysis passed — confidence ${(resp.confidence_score * 100).toFixed(0)}%.`,
        );
      else
        toast(
          `Final analysis confidence ${(resp.confidence_score * 100).toFixed(0)}% — flagged for human review.`,
        );
    } catch (e: any) {
      setFinalAnalysis({
        status: "error",
        fraudFlagged: false,
        sameDayCount: eligibility.sameDayCount,
        error: e?.message ?? "Analysis failed",
      });
      toast.error(`Final analysis error: ${e?.message ?? "unknown"}`);
    }
  }

  const [submitting, setSubmitting] = useState(false);

  function computeDocumentsOutcome(): {
    status: "APPROVED" | "FAILED" | "UNDER_REVIEW";
    reason: string;
  } {
    const required: string[] = docReq?.required ?? [];
    const optional: string[] = docReq?.optional ?? [];

    for (const t of required) {
      const d = docs[t];
      if (d?.status === "failed" || d?.status === "unprocessable") {
        return {
          status: "FAILED",
          reason: `Required document "${DOCUMENT_TYPES[t] ?? t}" ${
            d.status === "unprocessable" ? "could not be verified after max attempts" : "failed verification"
          }.`,
        };
      }
    }
    const anyReqReview = required.some((t) => docs[t]?.status === "review");
    const anyOptReview = optional.some((t) => ["review", "failed", "unprocessable"].includes(docs[t]?.status ?? ""));
    if (anyReqReview || anyOptReview) return { status: "UNDER_REVIEW", reason: "One or more documents need human review." };
    const allReqApproved = required.every((t) => docs[t]?.status === "approved");
    if (allReqApproved) return { status: "APPROVED", reason: "All required documents verified." };
    return { status: "UNDER_REVIEW", reason: "Document verification incomplete." };
  }

  async function finalSubmit() {
    if (!primary || !claimant || !eligibility || !category) return;
    setSubmitting(true);
    await new Promise((r) => setTimeout(r, 500));
    const amt = Number(amount);
    const docOutcome = computeDocumentsOutcome();
    // Eligibility failure short-circuits to REJECTED. Otherwise doc outcome
    // decides — UNLESS final analysis flagged the claim (fraud pattern or low
    // confidence), which routes to PENDING_REVIEW — distinct from the
    // doc-verification-driven UNDER_REVIEW — regardless of doc outcome.
    let status: StoredClaim["status"] = !eligibility.passed ? "REJECTED" : docOutcome.status;
    if (status !== "REJECTED" && finalAnalysis?.outcome === "HUMAN_REVIEW") {
      status = "PENDING_REVIEW";
    }
    const approvedAmount =
      status === "APPROVED"
        ? eligibility.approvedAmount
        : status === "UNDER_REVIEW"
          ? eligibility.approvedAmount
          : 0;

    const documents: DocVerification[] = allDocTypes.map((t) => {
      const d = docs[t];
      const required = (docReq?.required ?? []).includes(t);
      if (!d || !d.file) {
        return { type: t, filename: "", size: 0, decision: "NOT_UPLOADED", attempts: 0, required };
      }
      const decision: DocVerification["decision"] =
        d.status === "approved" ? "APPROVED" : d.status === "failed" || d.status === "unprocessable" ? "FAILED" : "UNDER_REVIEW";
      return {
        type: t,
        filename: d.file.name,
        size: d.file.size,
        decision,
        attempts: d.attempts,
        confidence: d.confidence,
        reasoning: d.reasoning,
        required,
      };
    });

    const claim: StoredClaim = {
      id: "CLM" + Date.now().toString(36).toUpperCase(),
      ticket,
      submitted_at: new Date().toISOString(),
      primary_member_id: primary.member_id,
      claimant_id: claimant.member_id,
      claimant_name: claimant.name,
      relationship: claimant.relationship,
      category,
      treatment_date: treatmentDate,
      hospital,
      in_network: inNetwork,
      amount: amt,
      approved_amount: approvedAmount,
      status,
      admin_override: adminOverride,
      reason:
        status === "REJECTED"
          ? eligibility.rules
              .filter((r) => !r.ok)
              .map((r) => r.label)
              .join("; ")
          : finalAnalysis?.outcome === "HUMAN_REVIEW"
            ? finalAnalysis.fraudFlagged
              ? `Unusual same-day claim pattern (${finalAnalysis.sameDayCount} prior claims today) — routed to human review.`
              : `Final analysis confidence ${((finalAnalysis.confidence ?? 0) * 100).toFixed(0)}% below threshold — routed to human review.`
            : docOutcome.reason,
      documents,
    };
    saveClaim(claim);
    onSubmitted(claim);
    setSubmitting(false);
    toast.success(`Claim ${claim.id} submitted — ${status.replace("_", "-")}.`);
  }

  function resetAll() {
    setCurrent("member");
    setLocked({
      member: false,
      claim: false,
      eligibility: false,
      documents: false,
      analysis: false,
      review: false,
    });
    setMemberIdInput("");
    setPrimary(null);
    setClaimantId("");
    setCategory("");
    setTreatmentDate("");
    setAmount("");
    setHospitalChoice("");
    setHospitalOther("");
    setEligibility(null);
    setDocs({});
    setVerifyResult(null);
    setAdminOverride("NO");
    setFinalAnalysis(null);
    setShowLogs(false);
  }

  function cancelClaim() {
    resetAll();
    onCancelClaim?.();
  }

  return (
    <div className="space-y-6">
      {/* Ticket banner */}
      <div className="flex items-center justify-between gap-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/15 text-primary">
            <Ticket className="h-4 w-4" />
          </div>
          <div>
            <div className="text-xs text-muted-foreground">
              Claim ticket (use this for any logs / support)
            </div>
            <div className="font-mono text-base font-semibold tracking-wider text-foreground">
              {ticket}
            </div>
          </div>
        </div>
        <Badge variant="secondary">In progress</Badge>
      </div>

      <div className="grid gap-8 lg:grid-cols-[280px_1fr]">
        {/* Stepper */}
        <aside className="lg:sticky lg:top-8 lg:self-start">
          <ol className="space-y-1">
            {STAGES.map((s, i) => {
              const isCurrent = current === s.id;
              const isLocked = locked[s.id];
              return (
                <li key={s.id}>
                  <button
                    type="button"
                    onClick={() => isLocked && setCurrent(s.id)}
                    disabled={!isLocked && !isCurrent}
                    className={cn(
                      "w-full text-left rounded-xl p-3 transition-colors border border-transparent",
                      isCurrent && "border-border bg-card shadow-sm",
                      isLocked && !isCurrent && "hover:bg-muted/60",
                    )}
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className={cn(
                          "flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold shrink-0",
                          isLocked
                            ? "bg-primary text-primary-foreground"
                            : isCurrent
                            ? "bg-foreground text-background"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        {isLocked ? <Check className="h-3.5 w-3.5" /> : i + 1}
                      </span>
                      <div className="min-w-0">
                        <div className="text-sm font-medium text-foreground truncate">{s.title}</div>
                        <div className="text-xs text-muted-foreground truncate">{s.subtitle}</div>
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ol>
        </aside>

        <section className="space-y-4">
          {/* STAGE 1 — DO NOT MODIFY */}
          <StageCard title="1. Member & Beneficiary" locked={locked.member} active={current === "member"}>
            {locked.member ? (
              <ReadOnlyRows
                rows={[
                  ["Primary Member", `${primary?.name} · ${primary?.member_id}`],
                  ["Claiming for", `${claimant?.name} · ${claimant?.relationship}`],
                ]}
              />
            ) : (
              <div className="space-y-4">
                <div className="grid gap-2 sm:grid-cols-[1fr_auto]">
                  <div>
                    <Label htmlFor="mid">Primary Member ID</Label>
                    <Input
                      id="mid"
                      placeholder="e.g. EMP001"
                      value={memberIdInput}
                      onChange={(e) => setMemberIdInput(e.target.value.toUpperCase())}
                      className="mt-1.5"
                    />
                  </div>
                  <Button variant="secondary" className="sm:mt-7" onClick={lookupMember}>
                    Verify
                  </Button>
                </div>
                {primary && (
                  <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
                    <div className="font-medium text-foreground">{primary.name}</div>
                    <div className="text-muted-foreground">
                      DOB {primary.date_of_birth} · Joined {primary.join_date} · {beneficiaries.length} eligible
                      beneficiar{beneficiaries.length === 1 ? "y" : "ies"}
                    </div>
                  </div>
                )}
                {primary && (
                  <div>
                    <Label>Claiming for</Label>
                    <Select value={claimantId} onValueChange={setClaimantId}>
                      <SelectTrigger className="mt-1.5">
                        <SelectValue placeholder="Select beneficiary" />
                      </SelectTrigger>
                      <SelectContent>
                        {beneficiaries.map((b) => (
                          <SelectItem key={b.member_id} value={b.member_id}>
                            {b.name} — {b.relationship} ({b.member_id})
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                )}
                <StageActions onSubmit={() => submitStage("member")} />
              </div>
            )}
          </StageCard>

          {/* STAGE 2 */}
          {(current === "claim" || locked.claim) && (
            <StageCard title="2. Claim Details" locked={locked.claim} active={current === "claim"}>
              {locked.claim ? (
                <ReadOnlyRows
                  rows={[
                    ["Category", category],
                    ["Treatment date", treatmentDate],
                    ["Provider", `${hospital} ${inNetwork ? "· In-network" : "· Out-of-network"}`],
                    ["Claim amount", `₹${Number(amount).toLocaleString("en-IN")}`],
                  ]}
                />
              ) : (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="sm:col-span-2">
                    <Label>Claim Category</Label>
                    <Select
                      value={category}
                      onValueChange={(v) => {
                        setCategory(v as CategoryKey);
                        invalidateVerify();
                      }}
                    >
                      <SelectTrigger className="mt-1.5">
                        <SelectValue placeholder="Select category" />
                      </SelectTrigger>
                      <SelectContent>
                        {OPD_CATEGORIES.map((c) => {
                          const cfg = getCategoryConfig(c.key);
                          return (
                            <SelectItem key={c.key} value={c.key}>
                              {c.label} — sub-limit ₹{cfg.sub_limit.toLocaleString("en-IN")}
                            </SelectItem>
                          );
                        })}
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label htmlFor="td">Treatment Date</Label>
                    <Input
                      id="td"
                      type="date"
                      value={treatmentDate}
                      onChange={(e) => {
                        setTreatmentDate(e.target.value);
                        invalidateVerify();
                      }}
                      className="mt-1.5"
                    />
                  </div>
                  <div>
                    <Label htmlFor="amt">Claim Amount (₹)</Label>
                    <Input
                      id="amt"
                      type="number"
                      min={0}
                      value={amount}
                      onChange={(e) => {
                        setAmount(e.target.value);
                        invalidateVerify();
                      }}
                      className="mt-1.5"
                    />
                  </div>
                  <div className="sm:col-span-2">
                    <Label>Hospital / Clinic / Provider</Label>
                    <Select
                      value={hospitalChoice}
                      onValueChange={(v) => {
                        setHospitalChoice(v);
                        invalidateVerify();
                      }}
                    >
                      <SelectTrigger className="mt-1.5">
                        <SelectValue placeholder="Select a provider" />
                      </SelectTrigger>
                      <SelectContent>
                        {policy.network_hospitals.map((h) => (
                          <SelectItem key={h} value={h}>
                            {h} · Network
                          </SelectItem>
                        ))}
                        <SelectItem value={HOSPITAL_OTHER}>Other (enter manually)</SelectItem>
                      </SelectContent>
                    </Select>
                    {hospitalChoice === HOSPITAL_OTHER && (
                      <Input
                        placeholder="Enter hospital / clinic name"
                        value={hospitalOther}
                        onChange={(e) => {
                          setHospitalOther(e.target.value);
                          invalidateVerify();
                        }}
                        className="mt-2"
                      />
                    )}
                    {hospital && (
                      <p className="mt-1.5 text-xs text-muted-foreground">
                        {inNetwork ? (
                          <span className="text-primary">✓ Network hospital — discount applies</span>
                        ) : (
                          "Out-of-network provider"
                        )}
                      </p>
                    )}
                  </div>

                  {/* ---- ADMIN OVERRIDE (plug-in) ---- */}
                  <div className="sm:col-span-2 rounded-lg border border-dashed border-border bg-muted/30 p-3">
                    <Label htmlFor="admin-override" className="text-xs uppercase tracking-wide text-muted-foreground">
                      admin_override
                    </Label>
                    <div className="mt-1.5 flex items-center gap-3">
                      <Select
                        value={adminOverride}
                        onValueChange={(v) => {
                          setAdminOverride(v as "YES" | "NO");
                          invalidateVerify();
                        }}
                      >
                        <SelectTrigger id="admin-override" className="w-32">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="NO">NO</SelectItem>
                          <SelectItem value="YES">YES</SelectItem>
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">
                        Overrides date-related eligibility failures only.
                      </p>
                    </div>
                  </div>
                  {/* ---- END ADMIN OVERRIDE ---- */}

                  <div className="sm:col-span-2 space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Button variant="secondary" onClick={runVerify} disabled={verifying}>
                        {verifying ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Verifying…
                          </>
                        ) : (
                          <>
                            <BadgeCheck className="mr-2 h-4 w-4" /> Verify
                          </>
                        )}
                      </Button>
                      {verifyResult && (
                        <Badge variant={verifyResult.passed ? "default" : "destructive"}>
                          {verifyResult.passed ? "All checks passed" : "Verification failed"}
                        </Badge>
                      )}
                    </div>

                    {verifyResult && (
                      <ul className="divide-y divide-border rounded-lg border border-border">
                        {verifyResult.rules.map((r, i) => (
                          <li key={i} className="flex items-start gap-3 p-2.5">
                            <span
                              className={cn(
                                "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
                                r.ok ? "bg-primary/15 text-primary" : "bg-destructive/15 text-destructive",
                              )}
                            >
                              {r.ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-medium text-foreground">{r.label}</div>
                              <div className="text-xs text-muted-foreground">{r.detail}</div>
                            </div>
                          </li>
                        ))}
                      </ul>
                    )}

                    {verifyResult?.passed && <StageActions onSubmit={() => submitStage("claim")} />}
                  </div>
                </div>
              )}
            </StageCard>
          )}

          {/* STAGE 3 */}
          {(current === "eligibility" || locked.eligibility) && eligibility && (
            <StageCard title="3. Eligibility Check" locked={locked.eligibility} active={current === "eligibility"}>
              <div className="space-y-3">
                <ul className="divide-y divide-border rounded-lg border border-border">
                  {eligibility.rules.map((r, i) => (
                    <li key={i} className="flex items-start gap-3 p-3">
                      <span
                        className={cn(
                          "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
                          r.ok ? "bg-primary/15 text-primary" : "bg-destructive/15 text-destructive",
                        )}
                      >
                        {r.ok ? <Check className="h-3 w-3" /> : <X className="h-3 w-3" />}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-foreground">{r.label}</div>
                        <div className="text-xs text-muted-foreground">{r.detail}</div>
                      </div>
                    </li>
                  ))}
                </ul>
                {eligibility.passed ? (
                  <div className="rounded-lg border border-primary/30 bg-primary/5 p-4">
                    <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                      <ShieldCheck className="h-4 w-4 text-primary" /> Estimated approved amount
                    </div>
                    <div className="mt-1 text-2xl font-semibold text-foreground">
                      ₹{eligibility.approvedAmount.toLocaleString("en-IN")}
                    </div>
                    <div className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-3">
                      <div>Claimed: ₹{Number(amount).toLocaleString("en-IN")}</div>
                      <div>
                        Network discount: −₹{eligibility.networkDiscount.toLocaleString("en-IN")}
                      </div>
                      <div>Co-pay: −₹{eligibility.copay.toLocaleString("en-IN")}</div>
                    </div>
                    {eligibility.notes.length > 0 && (
                      <ul className="mt-2 list-disc pl-5 text-xs text-muted-foreground">
                        {eligibility.notes.map((n, i) => (
                          <li key={i}>{n}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                ) : (
                  <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
                    <AlertCircle className="mt-0.5 h-4 w-4 text-destructive" />
                    <div>
                      <div className="font-medium text-foreground">Claim cannot proceed</div>
                      <div className="text-muted-foreground">
                        Resolve the failing rules above. You can cancel and start a new claim.
                      </div>
                    </div>
                  </div>
                )}
                {!locked.eligibility && (
                  <div className="flex gap-2">
                    <Button
                      onClick={() => submitStage("eligibility")}
                      disabled={!eligibility.passed}
                    >
                      Accept & Continue
                    </Button>
                    <Button variant="ghost" onClick={cancelClaim}>
                      Cancel claim
                    </Button>
                  </div>
                )}
              </div>
            </StageCard>
          )}

          {/* STAGE 4 */}
          {(current === "documents" || locked.documents) && docReq && (
            <StageCard
              title="4. Supporting Documents"
              locked={locked.documents}
              active={current === "documents"}
            >
              {locked.documents ? (
                <div className="space-y-1.5 text-sm">

                  {docReq.required.some((t: string) => docs[t]?.status === "unprocessable") && (
                    <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm">
                      <AlertCircle className="mt-0.5 h-4 w-4 text-destructive shrink-0" />
                      <div className="flex-1">
                        <div className="font-medium text-foreground">
                          A required document hit the {MAX_DOC_ATTEMPTS}-attempt limit
                        </div>
                        <div className="text-muted-foreground">
                          It's locked as unprocessable; submitting as-is will reject this claim. Cancel and start a fresh claim with a new ticket if the document genuinely can't be verified.
                        </div>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="destructive"
                        onClick={cancelClaim}
                        className="shrink-0"
                      >
                        Cancel & start over
                      </Button>
                    </div>
                  )}

                  {allDocTypes.map((t) => {
                    const d = docs[t];
                    if (!d?.file) return null;
                    return (
                      <div key={t} className="flex items-center gap-2 text-muted-foreground">
                        <FileText className="h-4 w-4" /> {DOCUMENT_TYPES[t] ?? t} — {d.file.name}{" "}
                        <Badge
                          variant="outline"
                          className={cn(
                            d.status === "approved" && "border-primary/40 text-primary",
                            d.status === "failed" && "border-destructive/40 text-destructive",
                            d.status === "review" && "border-amber-500/40 text-amber-600",
                          )}
                        >
                          {d.status}
                        </Badge>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="space-y-4">
                  {/* Endpoint configuration */}
                  <div className="rounded-lg border border-dashed border-border bg-muted/30 p-3">
                    <Label htmlFor="ep" className="text-xs uppercase tracking-wide text-muted-foreground">
                      Verification endpoint (langgraph /process-claim)
                    </Label>
                    <Input
                      id="ep"
                      placeholder="https://your-host"
                      value={endpoint}
                      onChange={(e) => {
                        setEndpointState(e.target.value);
                        setEndpoint(e.target.value);
                      }}
                      className="mt-1.5 font-mono text-xs"
                    />
                    <p className="mt-1 text-xs text-muted-foreground">
                      Each document is POSTed individually as <code>multipart/form-data</code> to{" "}
                      <code>{endpoint || "<host>"}/process-claim</code>.
                    </p>
                  </div>

                  <p className="text-xs text-muted-foreground">
                    Required for <span className="font-medium text-foreground">{category}</span>.
                    PDF/JPG/PNG, max 5MB. Each document allows up to {MAX_DOC_ATTEMPTS} verification attempts.
                  </p>

                  {allDocTypes.map((t) => (
                    <DocVerifyRow
                      key={t}
                      label={DOCUMENT_TYPES[t] ?? t}
                      required={docReq.required.includes(t)}
                      state={docs[t] ?? emptyDoc()}
                      maxAttempts={MAX_DOC_ATTEMPTS}
                      onPick={(f) => uploadDoc(t, f)}
                      onClear={() => clearDoc(t)}
                    />
                  ))}
                  <StageActions onSubmit={() => submitStage("documents")} />
                </div>
              )}
            </StageCard>
          )}
          {/* STAGE 5 */}
          {(current === "analysis" || locked.analysis) && eligibility && (
            <StageCard title="5. Final Analysis" locked={locked.analysis} active={current === "analysis"}>
              <div className="space-y-4">
                {/* Verification logs — optional view */}
                <div className="rounded-lg border border-border">
                  <button
                    type="button"
                    onClick={() => setShowLogs((s) => !s)}
                    className="flex w-full items-center justify-between gap-2 p-3 text-sm font-medium text-foreground"
                  >
                    <span className="flex items-center gap-2">
                      <Eye className="h-4 w-4" /> Document verification logs
                    </span>
                    {showLogs ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </button>
                  {showLogs && (
                    <div className="space-y-2 border-t border-border p-3">
                      {allDocTypes.filter((t) => docs[t]?.file).length === 0 && (
                        <p className="text-xs text-muted-foreground">No documents uploaded.</p>
                      )}
                      {allDocTypes.map((t) => {
                        const d = docs[t];
                        if (!d?.file) return null;
                        return (
                          <div key={t} className="rounded-md bg-muted/40 p-2.5 text-xs">
                            <div className="flex flex-wrap items-center gap-2 font-medium text-foreground">
                              <FileText className="h-3.5 w-3.5" /> {DOCUMENT_TYPES[t] ?? t} — {d.file.name}
                              <Badge
                                variant="outline"
                                className={cn(
                                  d.status === "approved" && "border-primary/40 text-primary",
                                  (d.status === "failed" || d.status === "unprocessable") &&
                                    "border-destructive/40 text-destructive",
                                  d.status === "review" && "border-amber-500/40 text-amber-600",
                                )}
                              >
                                {d.status}
                              </Badge>
                              <span className="text-muted-foreground">
                                attempts {d.attempts}/{MAX_DOC_ATTEMPTS}
                              </span>
                            </div>
                            {d.confidence !== undefined && (
                              <div className="mt-1 text-muted-foreground">
                                confidence {(d.confidence * 100).toFixed(0)}%
                              </div>
                            )}
                            {d.reasoning && (
                              <div className="mt-1 whitespace-pre-line text-muted-foreground">{d.reasoning}</div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Fraud-detection: same-day claim pattern */}
                <div className="flex items-start gap-3 rounded-lg border border-border p-3">
                  <span
                    className={cn(
                      "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
                      eligibility.sameDayFlagged ? "bg-amber-500/15 text-amber-600" : "bg-primary/15 text-primary",
                    )}
                  >
                    {eligibility.sameDayFlagged ? <ShieldAlert className="h-3 w-3" /> : <Check className="h-3 w-3" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-foreground">Same-day claim pattern</div>
                    <div className="text-xs text-muted-foreground">
                      {eligibility.sameDayFlagged
                        ? `Member ${primary?.member_id} has already submitted ${eligibility.sameDayCount} claim(s) today — this would be claim #${eligibility.sameDayCount + 1}. Flagged for human review, not auto-rejected.`
                        : `${eligibility.sameDayCount} prior claim(s) from this member today — within normal range.`}
                    </div>
                  </div>
                </div>

                {/* Endpoint config — only relevant if the fraud check didn't already flag this */}
                {!eligibility.sameDayFlagged &&
                  (!finalAnalysis || finalAnalysis.status === "idle" || finalAnalysis.status === "error") && (
                    <div className="rounded-lg border border-dashed border-border bg-muted/30 p-3">
                      <Label htmlFor="fae" className="text-xs uppercase tracking-wide text-muted-foreground">
                        Final analysis endpoint
                      </Label>
                      <Input
                        id="fae"
                        placeholder="https://your-host"
                        value={finalAnalysisEndpoint}
                        onChange={(e) => {
                          setFinalAnalysisEndpointState(e.target.value);
                          setFinalAnalysisEndpoint(e.target.value);
                        }}
                        className="mt-1.5 font-mono text-xs"
                      />
                      <p className="mt-1 text-xs text-muted-foreground">
                        Sends the assembled claim (eligibility outcome + document verification results) as JSON to{" "}
                        <code>{finalAnalysisEndpoint || "<host>"}/final-analysis</code>.
                      </p>
                    </div>
                  )}

                {finalAnalysis?.status === "done" && !finalAnalysis.fraudFlagged && (
                  <div
                    className={cn(
                      "flex items-start gap-3 rounded-lg border p-3",
                      finalAnalysis.outcome === "SUCCESS"
                        ? "border-primary/30 bg-primary/5"
                        : "border-amber-500/30 bg-amber-500/5",
                    )}
                  >
                    {finalAnalysis.outcome === "SUCCESS" ? (
                      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    ) : (
                      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                    )}
                    <div className="min-w-0 flex-1 text-sm">
                      <div className="font-medium text-foreground">
                        Confidence {((finalAnalysis.confidence ?? 0) * 100).toFixed(0)}% —{" "}
                        {finalAnalysis.outcome === "SUCCESS" ? "Passed" : "Flagged for human review"}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {finalAnalysis.outcome === "SUCCESS"
                          ? "Above the 80% confidence threshold."
                          : "Below the 80% confidence threshold."}
                      </div>
                    </div>
                  </div>
                )}

                {finalAnalysis?.status === "error" && (
                  <div className="rounded-md bg-destructive/5 p-2.5 text-xs text-destructive">
                    {finalAnalysis.error}
                  </div>
                )}

                {!locked.analysis && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button onClick={runFinalAnalysisStage} disabled={finalAnalysis?.status === "running"}>
                      {finalAnalysis?.status === "running" ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Analyzing…
                        </>
                      ) : (
                        <>
                          <BadgeCheck className="mr-2 h-4 w-4" /> Run Final Analysis
                        </>
                      )}
                    </Button>
                    {finalAnalysis?.status === "done" && <StageActions onSubmit={() => submitStage("analysis")} />}
                  </div>
                )}
              </div>
            </StageCard>
          )}

          {/* STAGE 5 */}
          {(current === "analysis" || locked.analysis) && eligibility && (
            <StageCard title="5. Final Analysis" locked={locked.analysis} active={current === "analysis"}>
              <div className="space-y-4">
                {/* Verification logs — optional view */}
                <div className="rounded-lg border border-border">
                  <button
                    type="button"
                    onClick={() => setShowLogs((s) => !s)}
                    className="flex w-full items-center justify-between gap-2 p-3 text-sm font-medium text-foreground"
                  >
                    <span className="flex items-center gap-2">
                      <Eye className="h-4 w-4" /> Document verification logs
                    </span>
                    {showLogs ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </button>
                  {showLogs && (
                    <div className="space-y-2 border-t border-border p-3">
                      {allDocTypes.filter((t) => docs[t]?.file).length === 0 && (
                        <p className="text-xs text-muted-foreground">No documents uploaded.</p>
                      )}
                      {allDocTypes.map((t) => {
                        const d = docs[t];
                        if (!d?.file) return null;
                        return (
                          <div key={t} className="rounded-md bg-muted/40 p-2.5 text-xs">
                            <div className="flex flex-wrap items-center gap-2 font-medium text-foreground">
                              <FileText className="h-3.5 w-3.5" /> {DOCUMENT_TYPES[t] ?? t} — {d.file.name}
                              <Badge
                                variant="outline"
                                className={cn(
                                  d.status === "approved" && "border-primary/40 text-primary",
                                  (d.status === "failed" || d.status === "unprocessable") &&
                                    "border-destructive/40 text-destructive",
                                  d.status === "review" && "border-amber-500/40 text-amber-600",
                                )}
                              >
                                {d.status}
                              </Badge>
                              <span className="text-muted-foreground">
                                attempts {d.attempts}/{MAX_DOC_ATTEMPTS}
                              </span>
                            </div>
                            {d.confidence !== undefined && (
                              <div className="mt-1 text-muted-foreground">
                                confidence {(d.confidence * 100).toFixed(0)}%
                              </div>
                            )}
                            {d.reasoning && (
                              <div className="mt-1 whitespace-pre-line text-muted-foreground">{d.reasoning}</div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Fraud-detection: same-day claim pattern */}
                <div className="flex items-start gap-3 rounded-lg border border-border p-3">
                  <span
                    className={cn(
                      "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full",
                      eligibility.sameDayFlagged ? "bg-amber-500/15 text-amber-600" : "bg-primary/15 text-primary",
                    )}
                  >
                    {eligibility.sameDayFlagged ? <ShieldAlert className="h-3 w-3" /> : <Check className="h-3 w-3" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium text-foreground">Same-day claim pattern</div>
                    <div className="text-xs text-muted-foreground">
                      {eligibility.sameDayFlagged
                        ? `Member ${primary?.member_id} has already submitted ${eligibility.sameDayCount} claim(s) today — this would be claim #${eligibility.sameDayCount + 1}. Flagged for human review, not auto-rejected.`
                        : `${eligibility.sameDayCount} prior claim(s) from this member today — within normal range.`}
                    </div>
                  </div>
                </div>

                {/* Endpoint config — only relevant if the fraud check didn't already flag this */}
                {!eligibility.sameDayFlagged &&
                  (!finalAnalysis || finalAnalysis.status === "idle" || finalAnalysis.status === "error") && (
                    <div className="rounded-lg border border-dashed border-border bg-muted/30 p-3">
                      <Label htmlFor="fae" className="text-xs uppercase tracking-wide text-muted-foreground">
                        Final analysis endpoint
                      </Label>
                      <Input
                        id="fae"
                        placeholder="https://your-host"
                        value={finalAnalysisEndpoint}
                        onChange={(e) => {
                          setFinalAnalysisEndpointState(e.target.value);
                          setFinalAnalysisEndpoint(e.target.value);
                        }}
                        className="mt-1.5 font-mono text-xs"
                      />
                      <p className="mt-1 text-xs text-muted-foreground">
                        Sends the assembled claim (eligibility outcome + document verification results) as JSON to{" "}
                        <code>{finalAnalysisEndpoint || "<host>"}/final-analysis</code>.
                      </p>
                    </div>
                  )}

                {finalAnalysis?.status === "done" && !finalAnalysis.fraudFlagged && (
                  <div
                    className={cn(
                      "flex items-start gap-3 rounded-lg border p-3",
                      finalAnalysis.outcome === "SUCCESS"
                        ? "border-primary/30 bg-primary/5"
                        : "border-amber-500/30 bg-amber-500/5",
                    )}
                  >
                    {finalAnalysis.outcome === "SUCCESS" ? (
                      <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                    ) : (
                      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                    )}
                    <div className="min-w-0 flex-1 text-sm">
                      <div className="font-medium text-foreground">
                        Confidence {((finalAnalysis.confidence ?? 0) * 100).toFixed(0)}% —{" "}
                        {finalAnalysis.outcome === "SUCCESS" ? "Passed" : "Flagged for human review"}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {finalAnalysis.outcome === "SUCCESS"
                          ? "Above the 80% confidence threshold."
                          : "Below the 80% confidence threshold."}
                      </div>
                    </div>
                  </div>
                )}

                {finalAnalysis?.status === "error" && (
                  <div className="rounded-md bg-destructive/5 p-2.5 text-xs text-destructive">
                    {finalAnalysis.error}
                  </div>
                )}

                {!locked.analysis && (
                  <div className="flex flex-wrap items-center gap-2">
                    <Button onClick={runFinalAnalysisStage} disabled={finalAnalysis?.status === "running"}>
                      {finalAnalysis?.status === "running" ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Analyzing…
                        </>
                      ) : (
                        <>
                          <BadgeCheck className="mr-2 h-4 w-4" /> Run Final Analysis
                        </>
                      )}
                    </Button>
                    {finalAnalysis?.status === "done" && <StageActions onSubmit={() => submitStage("analysis")} />}
                  </div>
                )}
              </div>
            </StageCard>
          )}

          {/* STAGE 6 */}
          {current === "review" && eligibility && (
            <StageCard title="6. Review & Submit" locked={false} active>
              <div className="space-y-4">
                <ReadOnlyRows
                  rows={[
                    ["Claimant", `${claimant?.name} (${claimant?.relationship})`],
                    ["Category", category],
                    ["Treatment date", treatmentDate],
                    ["Provider", `${hospital} ${inNetwork ? "(Network)" : "(Out-of-network)"}`],
                    ["Claim amount", `₹${Number(amount).toLocaleString("en-IN")}`],
                    ["Estimated payout", `₹${eligibility.approvedAmount.toLocaleString("en-IN")}`],
                    [
                      "Final analysis",
                      finalAnalysis
                        ? finalAnalysis.fraudFlagged
                          ? "Flagged — same-day claim pattern"
                          : `${finalAnalysis.outcome === "SUCCESS" ? "Passed" : "Flagged"} — confidence ${((finalAnalysis.confidence ?? 0) * 100).toFixed(0)}%`
                        : "Not run",
                    ],
                    [
                      "Documents",
                      allDocTypes
                        .map((t) => {
                          const d = docs[t];
                          if (!d?.file) return null;
                          return `${DOCUMENT_TYPES[t] ?? t}: ${d.status}`;
                        })
                        .filter(Boolean)
                        .join(" · "),
                    ],
                  ]}
                />
                <div className="flex gap-2">
                  <Button onClick={finalSubmit} disabled={submitting}>
                    {submitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Submit Claim
                  </Button>
                  <Button variant="ghost" onClick={resetAll}>
                    Cancel
                  </Button>
                </div>
              </div>
            </StageCard>
          )}
        </section>
      </div>
    </div>
  );
}

function StageCard({
  title,
  locked,
  active,
  children,
}: {
  title: string;
  locked: boolean;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "rounded-2xl border bg-card p-5 transition-all",
        active ? "border-border shadow-sm" : "border-border/60",
        locked && !active && "opacity-90",
      )}
    >
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-base font-semibold text-foreground">{title}</h3>
        {locked && (
          <Badge variant="secondary" className="gap-1">
            <Lock className="h-3 w-3" /> Locked
          </Badge>
        )}
      </div>
      {children}
    </div>
  );
}

function StageActions({ onSubmit }: { onSubmit: () => void }) {
  return (
    <div className="flex">
      <Button onClick={onSubmit}>Submit & Continue</Button>
    </div>
  );
}

function ReadOnlyRows({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="grid gap-2 text-sm sm:grid-cols-2">
      {rows.map(([k, v]) => (
        <div key={k} className="rounded-md bg-muted/40 px-3 py-2">
          <dt className="text-xs text-muted-foreground">{k}</dt>
          <dd className="font-medium text-foreground">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function DocVerifyRow({
  label,
  required,
  state,
  maxAttempts,
  onPick,
  onClear,
}: {
  label: string;
  required: boolean;
  state: DocState;
  maxAttempts: number;
  onPick: (f: File) => void;
  onClear: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const locked = state.status === "approved";
  const exhausted = state.attempts >= maxAttempts && state.status !== "approved";
  const triesLeft = Math.max(0, maxAttempts - state.attempts);

  const statusBadge = () => {
    switch (state.status) {
      case "uploading":
        return (
          <Badge variant="secondary" className="gap-1">
            <Loader2 className="h-3 w-3 animate-spin" /> Verifying
          </Badge>
        );
      case "approved":
        return <Badge className="bg-primary/15 text-primary border-primary/30 border">APPROVED</Badge>;
      case "failed":
        return <Badge variant="destructive">FAILED</Badge>;
      case "review":
        return (
          <Badge variant="outline" className="border-amber-500/40 text-amber-700 dark:text-amber-400">
            UNDER REVIEW
          </Badge>
        );
      case "error":
        return <Badge variant="outline" className="border-destructive/40 text-destructive">ERROR</Badge>;
      case "unprocessable":
        return <Badge variant="destructive">UNPROCESSABLE</Badge>;
      default:
        return null;
    }
  };

  return (
    <div
      className={cn(
        "rounded-lg border bg-card p-3 transition-colors",
        state.status === "approved"
          ? "border-primary/40"
          : state.status === "failed"
          ? "border-destructive/40"
          : state.status === "review"
          ? "border-amber-500/40"
          : "border-border",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3 min-w-0">
          <div className="flex h-9 w-9 items-center justify-center rounded-md bg-muted text-muted-foreground shrink-0">
            <FileText className="h-4 w-4" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-medium text-foreground flex items-center gap-2 flex-wrap">
              {label} {required && <span className="text-destructive">*</span>}
              {statusBadge()}
              {state.confidence !== undefined && (
                <span className="text-[10px] text-muted-foreground">
                  confidence {(state.confidence * 100).toFixed(0)}%
                </span>
              )}
            </div>
            <div className="text-xs text-muted-foreground truncate">
              {state.file ? `${state.file.name} · ${(state.file.size / 1024).toFixed(0)} KB` : "PDF, JPG or PNG · up to 5 MB"}
            </div>
            {state.reasoning && (
              <div
                className={cn(
                  "mt-1.5 rounded-md p-2 text-xs whitespace-pre-line",
                  state.status === "failed"
                    ? "bg-destructive/5 text-destructive"
                    : state.status === "approved"
                    ? "bg-primary/5 text-foreground"
                    : "bg-amber-500/5 text-foreground",
                )}
              >
                {state.reasoning}
              </div>
            )}
            {state.error && (
              <div className="mt-1.5 rounded-md bg-destructive/5 p-2 text-xs text-destructive">
                {state.error}
              </div>
            )}
            {!locked && (state.attempts > 0 || state.status === "failed") && (
              <div className="mt-1 text-[11px] text-muted-foreground">
                Attempt {state.attempts}/{maxAttempts}
                {state.status === "unprocessable"
                  ? " — maximum attempts reached, document unprocessable"
                  : exhausted
                    ? " — max retries reached"
                    : state.status === "failed"
                      ? ` — ${triesLeft} retr${triesLeft === 1 ? "y" : "ies"} left`
                      : ""}
              </div>
            )}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!locked && !exhausted && (
            <>
              <input
                ref={inputRef}
                type="file"
                accept=".pdf,.jpg,.jpeg,.png"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) onPick(f);
                  e.target.value = "";
                }}
              />
              <Button
                type="button"
                size="sm"
                variant={state.status === "failed" || state.status === "error" ? "secondary" : "outline"}
                onClick={() => inputRef.current?.click()}
                disabled={state.status === "uploading"}
              >
                {state.attempts === 0 ? (
                  <>
                    <Upload className="mr-1 h-3 w-3" /> Upload
                  </>
                ) : (
                  <>
                    <RefreshCw className="mr-1 h-3 w-3" /> Retry
                  </>
                )}
              </Button>
            </>
          )}
          {state.file &&
            !locked &&
            state.status !== "uploading" &&
            state.status !== "unprocessable" && (
              <Button type="button" size="sm" variant="ghost" onClick={onClear}>
                <X className="h-4 w-4" />
              </Button>
            )}
          {locked && (
            <Badge variant="secondary" className="gap-1">
              <Lock className="h-3 w-3" /> Closed
            </Badge>
          )}
          {state.status === "unprocessable" && (
            <Badge variant="destructive" className="gap-1">
              <Lock className="h-3 w-3" /> Locked
            </Badge>
          )}
        </div>
      </div>
    </div>
  );
}
