// Per-document verification against the langgraph /process-claim endpoint.
// Implements a confidence-based decision layer:
//   - result === "FAIL" && confidence >= 0.7  -> FAILED  (user gets up to 3 tries)
//   - result === "PASS" && confidence >= 0.6  -> APPROVED (locked)
//   - everything else                          -> UNDER_REVIEW

import type { CategoryKey } from "./policy";

export type ApiClaimCategory = "CONSULTATION" | "DIAGNOSTIC" | "PHARMACY" | "DENTAL" | "VISION" | "ALTERNATIVE_MEDICINE";

export function mapCategoryToApi(c: CategoryKey): ApiClaimCategory {
  if (c === "consultation") return "CONSULTATION";
  if (c === "diagnostic") return "DIAGNOSTIC";
  if (c === "pharmacy") return "PHARMACY";
  if (c === "dental") return "DENTAL";
  if (c === "vision") return "VISION";
  if (c === "alternative_medicine") return "ALTERNATIVE_MEDICINE";
  return "CONSULTATION"; // fallback
}

export type ProcessingResult = {
  confidence_score: number;
  reasoning: string;
  result: "PASS" | "FAIL";
};

export type ApiResponse = {
  processing_result: ProcessingResult;
  [k: string]: unknown;
};

export type DocDecision = "APPROVED" | "FAILED" | "UNDER_REVIEW";

export function decideFromResult(r: ProcessingResult): DocDecision {
  if (r.result === "FAIL" && r.confidence_score >= 0.7) return "FAILED";
  if (r.result === "PASS" && r.confidence_score >= 0.6) return "APPROVED";
  return "UNDER_REVIEW";
}

const API_URL = (import.meta.env.VITE_API_URL ?? "").replace(/\/+$/, "");
const API_KEY = import.meta.env.VITE_API_KEY ?? "";

export async function verifyDocument(params: {
  file: File;
  document_category: string; // which document this is — "PRESCRIPTION", "HOSPITAL_BILL", etc.
  patient_name: string;
  claim_category: ApiClaimCategory;
  treatment_date: string; // YYYY-MM-DD
  claimed_amt: number;
}): Promise<ApiResponse> {
  if (!API_URL) {
    throw new Error("VITE_API_URL is not configured");
  }
  const url = `${API_URL}/process-claim`;
  const fd = new FormData();
  fd.append("patient_name", params.patient_name);
  fd.append("claim_category", params.claim_category);
  fd.append("document_category", params.document_category);
  fd.append("treatment_date", params.treatment_date);
  fd.append("claimed_amt", String(params.claimed_amt));
  fd.append("document", params.file);

  const res = await fetch(url, {
    method: "POST",
    headers: { "X-API-Key": API_KEY }, // do NOT add Content-Type — FormData needs the browser-set boundary
    body: fd,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200) || res.statusText}`);
  }
  const rawResponse = await res.json();
  if (!rawResponse?.data?.processing_result) {
    throw new Error("Response missing processing_result");
  }
  return rawResponse.data as ApiResponse;
}