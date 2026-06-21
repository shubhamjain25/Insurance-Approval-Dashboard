import policyData from "@/data/policy_terms.json";

export const policy = policyData as Policy;

export type Member = {
  member_id: string;
  name: string;
  date_of_birth: string;
  gender: string;
  relationship: string;
  join_date?: string;
  dependents?: string[];
  primary_member_id?: string;
};

export type Policy = typeof policyData & { members: Member[] };

export const OPD_CATEGORIES = [
  { key: "consultation", label: "Consultation" },
  { key: "diagnostic", label: "Diagnostic / Lab Tests" },
  { key: "pharmacy", label: "Pharmacy" },
  { key: "dental", label: "Dental" },
  { key: "vision", label: "Vision" },
  { key: "alternative_medicine", label: "Alternative Medicine" },
] as const;

export type CategoryKey = (typeof OPD_CATEGORIES)[number]["key"];

export const DOCUMENT_TYPES: Record<string, string> = {
  PRESCRIPTION: "Prescription",
  HOSPITAL_BILL: "Hospital / Clinic Bill",
  PHARMACY_BILL: "Pharmacy Bill",
  LAB_REPORT: "Lab Report",
  DIAGNOSTIC_REPORT: "Diagnostic Report",
  DISCHARGE_SUMMARY: "Discharge Summary",
  DENTAL_REPORT: "Dental Report",
};

export function getMember(id: string): Member | undefined {
  return policy.members.find((m) => m.member_id.toUpperCase() === id.toUpperCase());
}

export function getBeneficiaries(primaryId: string): Member[] {
  const primary = getMember(primaryId);
  if (!primary) return [];
  const self = [primary];
  const deps = (primary.dependents ?? [])
    .map((id) => getMember(id))
    .filter((m): m is Member => !!m);
  return [...self, ...deps];
}

export function getCategoryConfig(key: CategoryKey) {
  return (policy.opd_categories as Record<string, any>)[key];
}
