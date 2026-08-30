/**
 * Post-debit gate-hint republication.
 *
 * This lives in its own module ON PURPOSE. Both inference settlers need it:
 * the KV fast path (`inference-billing-fast-path.ts`) and the DB ledger
 * (`inference-billing-ledger.ts`). Hanging it off the fast path instead would
 * force the ledger to import that module, which transitively pulls in
 * `api-keys` -> `db/repositories` -> `dbRead`, widening the ledger's module
 * graph for a single helper (and breaking callers that mock `db/helpers` at
 * its previous, narrower boundary).
 *
 * Its dependencies are leaves already used by both settlers:
 * `inference-auth-cache` and the isolate-local
 * `inference-admission-refusal`.
 */

import { clearOrgAdmissionRefused } from "./inference-admission-refusal";
import { republishOrgBalanceHint } from "./inference-auth-cache";

/**
 * Republish the gate hint with authoritative state after a committed inference
 * debit.
 *
 * A debit necessarily runs `CacheInvalidation.onCreditMutation`, which DELETES
 * `CacheKeys.inference.orgBalance`. That delete is correct for mutations whose
 * caller cannot know the resulting balance (top-ups, refunds, admin
 * adjustments), but the inference settler is the one mutation that both lowers
 * the balance and immediately knows the new value. Leaving the key absent made
 * the *next* turn a full miss, and on the Worker hot path a full miss is read
 * `cacheOnly` — a hard, user-visible 503 "Billing authorization is warming",
 * not a slow read. Every settled turn therefore armed a guaranteed failure for
 * the following turn (observed on staging as a strict 200/503 alternation).
 *
 * `lowerOrgBalanceHint` cannot repair this: it is lower-only and bails when no
 * entry exists, so after the delete it is always a no-op.
 *
 * The debit statement returns both the committed balance and trigger-advanced
 * revision. Passing that atomic result here avoids a post-debit primary read
 * while keeping the revision fresh rather than preserving a stale one.
 *
 * Republication is one write with no cache readback. The cache is a projection,
 * not the monetary authority: Worker dispatch is fenced by the serialized,
 * revision-aware InferenceAdmissionGate Durable Object. Non-Worker callers use
 * the atomic DB-ledger admission or reserve synchronously; the legacy KV lane
 * is never allowed to dispatch from this projection. Older snapshots therefore
 * cannot reopen an active gate even if concurrent writers reach Redis out of order.
 */
export async function republishOrgBalanceHintAfterDebit(
  organizationId: string,
  balanceUsd: number,
  balanceRevision: string,
): Promise<void> {
  const balanceAt = Date.now();
  await republishOrgBalanceHint(organizationId, balanceUsd, balanceAt, balanceRevision);
  clearOrgAdmissionRefused(organizationId);
}
