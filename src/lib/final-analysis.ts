// Second-pass LLM endpoint: takes the fully assembled claim (eligibility results, plus all document verification results) and runs a final analysis to produce a confidence score for auto-approval vs human review. This is designed to be flexible and allow plugging in different LLM providers or custom models as needed.

// outcome + per-document verification results) and returns one overall
// confidence score for the claim.
//   - confidence_score < 0.8  -> HUMAN_REVIEW
//   - confidence_score >= 0.8 -> SUCCESS

import type { ApiCategory } from "./doc-verify";

export type FinalAnalysisDocSummary = {
  type: string;
  decision: string; // mirrors DocState["status"]
  confidence?: number;
  reasoning?: string;
};

export type FinalAnalysisRequest = {
  endpoint: string;
  patient_name: string;
  claim_category: ApiCategory;
  treatment_date: string;
  claimed_amt: number;
  approved_amount: number;
  hospital: string;
  in_network: boolean;
  documents: FinalAnalysisDocSummary[];
};

export type FinalAnalysisResponse = {
  confidence_score: number;
  reasoning?: string;
  [k: string]: unknown;
};

export type FinalAnalysisOutcome = "SUCCESS" | "HUMAN_REVIEW";

export function decideFinalOutcome(confidence_score: number): FinalAnalysisOutcome {
  return confidence_score < 0.8 ? "HUMAN_REVIEW" : "SUCCESS";
}

export const FINAL_ANALYSIS_ENDPOINT_STORAGE_KEY = "claim_final_analysis_endpoint";

export function getFinalAnalysisEndpoint(): string {
  if (typeof window === "undefined") return "";
  return localStorage.getItem(FINAL_ANALYSIS_ENDPOINT_STORAGE_KEY) ?? "";
}

export function setFinalAnalysisEndpoint(url: string) {
  localStorage.setItem(FINAL_ANALYSIS_ENDPOINT_STORAGE_KEY, url);
}

export async function runFinalAnalysis(
  params: FinalAnalysisRequest,
): Promise<FinalAnalysisResponse> {
  const base = params.endpoint.replace(/\/+$/, "");
  const url = `${base}/final-analysis`;
  const { endpoint, ...body } = params;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${text.slice(0, 200) || res.statusText}`);
  }
  const json = (await res.json()) as FinalAnalysisResponse;
  if (typeof json?.confidence_score !== "number") {
    throw new Error("Response missing confidence_score");
  }
  return json;
}