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
 * Republishing authoritatively (balance AND revision) costs nothing net: the
 * identical `getOrganizationBalanceSnapshot` read already happened moments
 * later as the 503's background hydration. This only moves that read off the
 * next request's critical path, and it keeps the revision fresh rather than
 * preserving a stale one.
 *
 * The write is min-clamped (`republishOrgBalanceHint`) so the #9899 over-admit
 * bound survives: a concurrent debit that published a STRICTER gate while this
 * snapshot was in flight is never raised back up.
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
