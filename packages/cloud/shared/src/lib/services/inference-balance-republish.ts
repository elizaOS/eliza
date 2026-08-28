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
 * Its dependencies are exactly the three the ledger already carries or that are
 * leaves: `credits`, `inference-auth-cache`, and the isolate-local
 * `inference-admission-refusal`.
 */

import { creditsService } from "./credits";
import { clearOrgAdmissionRefused } from "./inference-admission-refusal";
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
 * Republishing authoritatively (balance AND revision) costs nothing net: the
 * identical `getOrganizationBalanceSnapshot` read already happened moments
 * later as the 503's background hydration. This only moves that read off the
 * next request's critical path, and it keeps the revision fresh rather than
 * preserving a stale one.
 *
 * Republication is one write with no cache readback. The cache is a projection,
 * not the monetary authority: Worker dispatch is fenced by the serialized,
 * revision-aware InferenceAdmissionGate Durable Object. Non-Worker callers use
 * the atomic DB-ledger admission or reserve synchronously; the legacy KV lane
 * is never allowed to dispatch from this projection. Older snapshots therefore
 * cannot reopen an active gate even if concurrent writers reach Redis out of order.
 */
export async function republishOrgBalanceHintAfterDebit(organizationId: string): Promise<void> {
  // Captured BEFORE the authoritative read, matching `refreshOrgBalanceHint`:
  // the timestamp marks when the read started, so a delayed old query can never
  // masquerade as fresher than a debit that committed while it was in flight.
  const balanceAt = Date.now();
  const snapshot = await creditsService.getOrganizationBalanceSnapshot(organizationId);
  await republishOrgBalanceHint(organizationId, snapshot.balanceUsd, balanceAt, snapshot.revision);
  clearOrgAdmissionRefused(organizationId);
}
