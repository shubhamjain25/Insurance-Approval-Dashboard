# Component Contracts

Precise interface definitions for every significant component in the system. Each entry is meant to be sufficient on its own — input shape, output shape, every error condition and how it surfaces, side effects, and the invariants the rest of the system relies on — so any one of these could be reimplemented from this document alone, in any language or framework, without reading the existing source.

---

## 1. `evaluateEligibility`

**File:** `eligibility.ts`
**Responsibility:** Deterministic policy evaluation for one claim — runs every eligibility/fraud rule, computes the payable amount, and returns a structured result. Does not mutate or persist anything.

**Input** — `EligibilityInput`

| Field | Type | Notes |
|---|---|---|
| `primary` | `Member` | The policyholder |
| `claimant` | `Member` | Who the claim is for (may equal `primary`) |
| `category` | `CategoryKey` | e.g. `"consultation"`, `"diagnostic"` |
| `treatmentDate` | `string` | `YYYY-MM-DD` |
| `amount` | `number` | Claimed amount, must be the raw entered value, not pre-capped |
| `hospital` | `string` | Free text or a network hospital name |
| `inNetwork` | `boolean` | Whether `hospital` matches the configured network list |

**Output** — `EligibilityOutput`

| Field | Type | Notes |
|---|---|---|
| `rules` | `RuleResult[]` | Ordered list of `{ ok, label, detail }` — one entry per rule evaluated, in evaluation order |
| `passed` | `boolean` | `true` only if every *blocking* rule passed. The same-day fraud rule is intentionally excluded from this computation — see Invariants. |
| `approvedAmount` | `number` | `0` if `passed` is `false`; otherwise claimed amount, capped by per-claim limit / category sub-limit / combined OPD limit, minus network discount, minus co-pay |
| `copay` | `number` | Amount deducted as co-pay |
| `networkDiscount` | `number` | Amount deducted as network discount (`0` if not `inNetwork`) |
| `notes` | `string[]` | Human-readable explanations of any capping/discount/copay applied |
| `sameDayCount` | `number` | Claims already submitted today by this `primary`, before this one |
| `sameDayFlagged` | `boolean` | `sameDayCount >= configured threshold` |

**Errors:** None thrown. This is a total function — every valid `EligibilityInput` produces a valid `EligibilityOutput`, including degenerate cases (e.g. an unconfigured `category` produces `passed: false` via the "category covered" rule, not an exception).

**Side effects:** Reads from the claims store (to compute prior claims for sub-limit, duplicate, and same-day checks). Writes nothing.

**Invariants:**
- `approvedAmount === 0` whenever `passed === false`.
- `sameDayFlagged` never affects `passed` — a flagged same-day pattern must still be able to reach later stages of the workflow; it is surfaced for a downstream component to act on, not enforced here.
- Calling this function twice with byte-identical input and an unchanged claims store returns byte-identical output (pure given a fixed store state).

---

## 2. `decideFromResult`

**File:** `doc-verify.ts`
**Responsibility:** Maps a single document's raw AI result to a decision category.

**Input** — `ProcessingResult`: `{ confidence_score: number; reasoning: string; result: "PASS" | "FAIL" }`

**Output** — `DocDecision`: `"APPROVED" | "FAILED" | "UNDER_REVIEW"`

**Logic (exhaustive):**
```
result === "FAIL" && confidence_score >= 0.7  -> "FAILED"
result === "PASS" && confidence_score >= 0.6  -> "APPROVED"
otherwise                                      -> "UNDER_REVIEW"
```

**Errors:** None — total function over all valid `ProcessingResult` values.
**Side effects:** None.
**Invariants:** Defined for every point in `[0, 1]` × `{PASS, FAIL}` — there is no input that falls through without a decision.

---

## 3. `verifyDocument`

**File:** `doc-verify.ts`
**Responsibility:** Submits one document to the backend and returns its full verification result.

**Input**

| Field | Type | Notes |
|---|---|---|
| `file` | `File` | The document being verified |
| `document_category` | `string` | Which document type this is (e.g. `"PRESCRIPTION"`, `"HOSPITAL_BILL"`) — must match the backend's `DocumentCategory` enum values exactly |
| `patient_name` | `string` | |
| `claim_category` | `"CONSULTATION" \| "OPD" \| "IPD" \| "PHARMACY"` | |
| `treatment_date` | `string` | `YYYY-MM-DD` |
| `claimed_amt` | `number` | |

Endpoint and API key are **not** parameters — read internally from `VITE_API_URL` / `VITE_API_KEY` at module load.

**Output** — `Promise<ApiResponse>`: `{ processing_result: ProcessingResult; [k: string]: unknown }`. The `[k: string]: unknown` is deliberate — the backend's full LangGraph state is preserved on the returned object beyond just `processing_result`, for the activity log to capture.

**Errors (all thrown as `Error`, caught by the caller — never silently swallowed):**

| Condition | Message |
|---|---|
| `VITE_API_URL` unset | `"VITE_API_URL is not configured"` |
| HTTP response not `ok` | `` `HTTP ${status}: ${body.slice(0, 200)}` `` |
| Response JSON missing `data.processing_result` | `"Response missing processing_result"` |

**Side effects:** One network call (`POST`, `multipart/form-data`, `X-API-Key` header). No retries, no caching — retry behavior is the caller's responsibility (see §4).

**Invariants:** Never resolves with a value lacking `processing_result` — either resolves with a complete, valid `ApiResponse`, or rejects. Callers do not need to defensively check for a partial success shape.

---

## 4. Document retry / circuit-breaker behavior

**File:** `claim-wizard.tsx` (`uploadDoc`, `clearDoc`, and the per-document state shape)
**Responsibility:** Wraps `verifyDocument` with a hard attempt cap, concurrency protection, and an explicit terminal state when the cap is reached. This is a stateful component, not a pure function — its contract is behavioral.

**State per document** — `DocState`:
```
{
  file: File | null
  attempts: number
  status: "idle" | "uploading" | "approved" | "failed" | "review" | "error" | "unprocessable"
  confidence?: number
  reasoning?: string
  error?: string
}
```

**Entry points:**
- `uploadDoc(type: string, file: File): Promise<void>` — triggered by file selection
- `clearDoc(type: string): void` — triggered by the clear button

**Guarantees:**
1. `attempts` never exceeds 3 (`MAX_DOC_ATTEMPTS`) for a given document slot across its entire lifetime, including across any number of `clearDoc` calls — `clearDoc` resets `file`/`status`/`reasoning`/`error` but never `attempts`.
2. At most one `verifyDocument` call is in flight per document slot at any time — a second `uploadDoc` call for the same slot while one is pending is a no-op.
3. If a request is superseded (the slot was cleared, or a newer request started) before its response arrives, that response is discarded — it never writes into state after being superseded. Implemented via a monotonically increasing per-slot request token.
4. The moment `attempts === 3` is reached on a `required` document without an `"approved"` outcome, `status` becomes `"unprocessable"` (terminal — no further `uploadDoc` or `clearDoc` calls are accepted for that slot) and the document-cannot-be-processed dialog is triggered. This guarantee does not apply to non-required (optional) documents — they reach `"unprocessable"` too, but do not trigger the blocking dialog.
5. Every terminal outcome (`approved`, `failed`, `review`, `unprocessable`, `error`) is logged via the activity log (§7) with the full `ApiResponse` attached, not just the fields acted on.

**Errors:** None thrown to any caller — all failure modes (network errors, validation failures, cap exhaustion) are captured into `DocState.status`/`error`, never propagated as exceptions out of `uploadDoc`.

---

## 5. Final Analysis computation

**File:** `claim-wizard.tsx` (`useMemo` deriving `FinalAnalysisState`)
**Responsibility:** Produces one claim-level confidence verdict from the eligibility result and the current document states. Pure derivation — no network call, no side effects.

**Input (implicit, via closure):** `eligibility: EligibilityOutput | null`, `docs: Record<string, DocState>`, `docReq` (required/optional document list for the claim's category), `docManualReview` (set if a required document was already routed to manual review via the dialog in §4)

**Output** — `FinalAnalysisState | null`:
```
{
  fraudFlagged: boolean
  sameDayCount: number
  perDocument: { type: string; label: string; confidence: number }[]
  averageConfidence: number
  outcome: "SUCCESS" | "HUMAN_REVIEW"
  reason: string
}
```
Returns `null` if `eligibility` is not yet available, or if `docManualReview` is already set (in which case the manual-review path takes precedence and this computation is not relevant).

**Decision order (exhaustive, evaluated in this sequence — see ARCHITECTURE.md §4 for why):**
1. If `eligibility.sameDayFlagged` — return immediately with `outcome: "HUMAN_REVIEW"`, `fraudFlagged: true`, `perDocument: []`. No averaging occurs.
2. Else, collect every document with `status === "approved"` and a defined `confidence`. If any required document is not `"approved"`, or no documents have a confidence score at all — return `outcome: "HUMAN_REVIEW"`, `fraudFlagged: false` (defensive: this should be unreachable given the stage-gating in §4, but is handled explicitly rather than averaging in incomplete data).
3. Else, `averageConfidence = mean(confidence scores)`; `outcome = averageConfidence >= 0.8 ? "SUCCESS" : "HUMAN_REVIEW"`.

**Errors:** None — total function over all reachable input states.
**Side effects:** None.

---

## 6. Activity Log

**File:** `claim-wizard.tsx` (`logEvent`, `eventLog` state), persisted via `claims-store.ts`
**Responsibility:** Append-only record of everything that happens during a claim's lifecycle, attached to the final stored claim.

**`logEvent` signature:**
```ts
function logEvent(stage: string, event: string, detail?: Record<string, unknown>): void
```

**`ClaimLogEntry` shape (what gets stored):**
```ts
{ at: string /* ISO timestamp */, stage: string, event: string, detail?: Record<string, unknown> }
```

**Guarantees:**
- Append-only for the duration of a wizard session — no entry is ever edited or removed once logged.
- The full in-memory `eventLog` array is attached verbatim to the `StoredClaim.log` field at the moment of either final submission or cancellation — nothing is summarized or dropped on persist.
- A document verification log entry's `detail` always contains the complete `ApiResponse` from the backend (everything LangGraph returned), not a curated subset.
- Claim information (claimant, hospital, category, treatment date, claimed amount) is logged once, at the point claim details are locked (end of Stage 2) — independent of and prior to any AI output, so the record of "what the person actually entered" is never conflated with "what the AI concluded."

**Errors:** None — `logEvent` cannot fail; it is a synchronous in-memory append.
**Side effects:** Mutates `eventLog` component state. Has no persistence effect on its own — persistence happens via `saveClaim` (§8) carrying the array along.

---

## 7. Claims Store

**File:** `claims-store.ts`
**Responsibility:** The only module permitted to read or write the underlying storage. Every other component goes through this interface, never `localStorage` directly.

### `loadClaims(): StoredClaim[]`
- **Output:** All stored claims, most recently saved first.
- **Errors:** None thrown. A malformed or missing stored value (corrupt JSON, `localStorage` unavailable) is caught internally and treated as `[]`.
- **Side effects:** Read-only.

### `saveClaim(claim: StoredClaim): void`
- **Input:** A complete `StoredClaim` — see field list in `claims-store.ts`'s type definition (includes `id`, `ticket`, `status`, `amount`, `approved_amount`, `documents`, `log`, etc.)
- **Output:** None.
- **Errors:** None thrown by this function directly — a `localStorage` quota error would propagate as an unhandled exception (not currently caught; see ARCHITECTURE.md limitations).
- **Side effects:** Prepends the claim to the stored list (most-recent-first ordering).
- **Invariant:** Does not validate `claim.id` uniqueness — caller is responsible for generating a unique ID (current implementation: `"CLM" + Date.now().toString(36).toUpperCase()`).

### `updateClaim(id: string, patch: Partial<StoredClaim>): void`
- **Input:** A claim `id` and a partial set of fields to overwrite.
- **Output:** None.
- **Errors:** None thrown. If no claim matches `id`, this is a silent no-op — the stored list is rewritten unchanged.
- **Side effects:** Replaces the matching claim's fields via shallow merge (`{ ...existing, ...patch }`) — does not deep-merge nested fields like `documents` or `log`; passing a partial `log` array would replace the whole array, not append to it.

---

## 8. FastAPI `/process-claim` endpoint

**File:** backend (separate repo)
**Responsibility:** Accepts one document plus claim context, runs the LangGraph verification workflow, returns the result.

**Input** — `multipart/form-data`:

| Field | Type | Required |
|---|---|---|
| `patient_name` | `str` | Yes |
| `claim_category` | `ClaimCategory` enum | Yes |
| `document_category` | `DocumentCategory` enum | Yes |
| `treatment_date` | `str` | Yes |
| `claimed_amt` | `float` | Yes |
| `document` | file upload | Yes |

**Header:** `X-API-Key` — required, validated via the `require_api_key` dependency before the handler runs.

**Output (success):** `{ "status": "success", "data": DocumentValidator }` where `DocumentValidator` includes at minimum `processing_result: { confidence_score, reasoning, result }`, plus whatever else the LangGraph graph's final state contains.

**Errors:**

| Condition | Response |
|---|---|
| Missing or invalid `X-API-Key` | `401`, via the `require_api_key` dependency |
| Missing/malformed required form field | `422`, FastAPI's standard validation error body |
| Exception during `compiled_graph.invoke(...)` | **Not currently handled explicitly** — surfaces as an unhandled `500` with FastAPI's default error body, not a documented error shape. This is a real gap: a frontend caller currently cannot distinguish "the graph itself failed" from any other unexpected server error. Wrapping the `invoke` call in explicit error handling with a typed error response is a direct follow-up. |

**Side effects:** Writes the uploaded file to local disk at `uploads/{filename}` before invoking the graph (see ARCHITECTURE.md — this does not survive a redeploy and does not work across multiple backend instances).

**Invariants (current implementation):** None enforced server-side around request frequency or attempt count per document — the 3-attempt cap described in §4 is a frontend-only control. A direct caller of this endpoint is not rate-limited by it.
