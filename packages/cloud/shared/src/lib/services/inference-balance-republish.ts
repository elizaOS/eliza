/**
 * Post-debit gate-hint republication.
 *
 * This lives in its own module so callers that settle balance changes do not
 * pull in `inference-billing-fast-path` (and its `api-keys` -> repositories
 * graph) for a single helper. Its dependency is the cache projection leaf.
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
 * through this authoritative overwrite, so the next Worker turn does not pay a
 * cold primary read for a balance the debit already returned.
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
 * revision-aware InferenceAdmissionGate Durable Object, and non-Worker callers
 * reserve synchronously. Older snapshots therefore
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
