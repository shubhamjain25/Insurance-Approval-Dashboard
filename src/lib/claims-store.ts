export type ClaimStatus =
  | "APPROVED"
  | "REJECTED"
  | "PENDING_REVIEW"
  | "UNDER_REVIEW"
  | "FAILED"
  | "CANCELLED";

export type DocVerification = {
  type: string;
  filename: string;
  size: number;
  decision: "APPROVED" | "FAILED" | "UNDER_REVIEW" | "NOT_UPLOADED";
  attempts: number;
  confidence?: number;
  reasoning?: string;
  required: boolean;
};

export type ClaimLogEntry = {
  at: string; // ISO timestamp
  stage: string;
  event: string;
  detail?: Record<string, unknown>;
};

export type StoredClaim = {
  id: string;
  ticket?: string;
  submitted_at: string;
  primary_member_id: string;
  claimant_id: string;
  claimant_name: string;
  relationship: string;
  category: string;
  treatment_date: string;
  hospital: string;
  in_network: boolean;
  amount: number;
  approved_amount: number;
  status: ClaimStatus;
  reason: string;
  // admin_override?: "YES" | "NO";
  documents: DocVerification[];
  log?: ClaimLogEntry[]; // full chronological event trail for this ticket
};

const KEY = "plum_claims_v1";

export function loadClaims(): StoredClaim[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]");
  } catch {
    return [];
  }
}

export function saveClaim(claim: StoredClaim) {
  const all = loadClaims();
  all.unshift(claim);
  localStorage.setItem(KEY, JSON.stringify(all));
}

export function updateClaim(id: string, patch: Partial<StoredClaim>) {
  const all = loadClaims().map((c) => (c.id === id ? { ...c, ...patch } : c));
  localStorage.setItem(KEY, JSON.stringify(all));
}
