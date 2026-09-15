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
 * Its dependency is the cache projection leaf already used by both settlers.
 */

import { republishOrgBalanceHint } from "./inference-auth-cache";

/**
 * Republish the gate hint with authoritative state after a committed inference
 * debit.
 *
 * Credit mutations normally run `CacheInvalidation.onCreditMutation`, which
 * deletes `CacheKeys.inference.orgBalance`. That delete is correct for callers
 * that cannot know the resulting balance (top-ups, refunds, admin adjustments).
 * A DO-fenced inference debit instead keeps the last valid projection present
 * only through this authoritative overwrite; legacy inference settlers still
 * delete then seed it here. Leaving the key absent until a later request made
 * the *next* Worker turn a full `cacheOnly` miss — a hard, user-visible 503
 * "Billing authorization is warming", not a slow read.
 *
 * `lowerOrgBalanceHint` cannot repair the delete path: it is lower-only and
 * bails when no entry exists, so after eviction it is always a no-op.
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
  options: {
    publishAuthoritativeBalance?: (balanceUsd: number, balanceRevision: string) => Promise<void>;
  } = {},
): Promise<void> {
  const balanceAt = Date.now();
  // Fence the committed revision before exposing its eventually consistent hint.
  await options.publishAuthoritativeBalance?.(balanceUsd, balanceRevision);
  await republishOrgBalanceHint(organizationId, balanceUsd, balanceAt, balanceRevision);
}
