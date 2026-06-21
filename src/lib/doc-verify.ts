// Per-document verification against the langgraph /process-claim endpoint.
// Implements a confidence-based decision layer:
//   - result === "FAIL" && confidence >= 0.7  -> FAILED  (user gets up to 3 tries)
//   - result === "PASS" && confidence >= 0.6  -> APPROVED (locked)
//   - everything else                          -> UNDER_REVIEW

import type { CategoryKey } from "./policy";

export type ApiCategory = "CONSULTATION" | "OPD" | "IPD" | "PHARMACY";

export function mapCategoryToApi(c: CategoryKey): ApiCategory {
  if (c === "consultation") return "CONSULTATION";
  if (c === "pharmacy") return "PHARMACY";
  return "OPD";
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

export const ENDPOINT_STORAGE_KEY = "claim_verify_endpoint";

export function getEndpoint(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(ENDPOINT_STORAGE_KEY) ?? "";
}

export function setEndpoint(url: string) {
  localStorage.setItem(ENDPOINT_STORAGE_KEY, url);
}

export async function verifyDocument(params: {
  endpoint: string;
  file: File;
  patient_name: string;
  claim_category: ApiCategory;
  treatment_date: string; // YYYY-MM-DD
  claimed_amt: number;
}): Promise<ApiResponse> {
  const base = params.endpoint.replace(/\/+$/, "");
  const url = `${base}/process-claim`;
  const fd = new FormData();
  fd.append("patient_name", params.patient_name);
  fd.append("claim_category", params.claim_category);
  fd.append("treatment_date", params.treatment_date);
  fd.append("claimed_amt", String(params.claimed_amt));
  fd.append("document", params.file);

  const res = await fetch(url, { method: "POST", body: fd });
  console.log("<--------------------------------->");
  console.log(res);
  console.log("<--------------------------------->");
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200) || res.statusText}`);
  }
  // Parse the top-level response
  const rawResponse = await res.json();
  console.log("\n", rawResponse);

  // Checking the nested 'data' object where LangGraph's state actually lives
  if (!rawResponse?.data?.processing_result) {
    console.log("\n", "Error Encountered");
    throw new Error("Response missing processing_result");
  }

  // Returning the nested state (assuming ApiResponse maps to DocumentValidator)
  console.log("\n", rawResponse.data);
  return rawResponse.data as ApiResponse;
}
