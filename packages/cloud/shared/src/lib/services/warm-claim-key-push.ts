/**
 * Warm-pool claim -> inference-credential re-key (F0).
 *
 * A warm-pool container boots under the sentinel pool org
 * (`WARM_POOL_ORG_ID`) with a managed cloud inference key
 * (`ELIZAOS_CLOUD_API_KEY`) minted for THAT org. `claimWarmContainer`
 * transfers the DB row to the claiming user's org, and #16977's character push
 * makes the running container answer AS the user's character — but nothing
 * re-credentials the container's inference key. The running container keeps
 * using the pool-org key, which the inference gateway rightly refuses to
 * bill/authorize for the claimed usage, so the very first reply is the agent's
 * fallback: "My Eliza Cloud key isn't authorized for inference right now."
 * Right face, no voice.
 *
 * The fix mirrors the character push exactly one layer down: after a claim we
 * mint a NEW inference key scoped to the CLAIMING user's org and push it onto
 * the live container through the container's OWN authenticated
 * `POST /api/cloud/login/persist` route (plugin-elizacloud cloud-routes),
 * which swaps the running runtime's cloud credential in-memory (process env
 * sealed store + character secrets + cloudManager + agent DB) with NO restart.
 * `forceInferenceEnabled: true` keeps inference on even if the container's
 * persisted config routing does not report cloud-proxy (the managed env is the
 * source of truth on the pool image, not the config file).
 *
 * Secret handling (mission constraint):
 *   - the plaintext key rides ONLY in the PUT body over the authed,
 *     TLS-internal (tailnet) agent transport `fetchAgentApi` uses;
 *   - it is NEVER logged and NEVER placed on an event — this module returns
 *     only a boolean `pushed` + the key PREFIX (first 12 chars, safe to log
 *     for correlation) and callers must log only that prefix;
 *   - the pool-org key that the container booted with is REVOKED on claim (the
 *     caller drives `apiKeysService.revokeForAgent` against the pool org) so no
 *     usable credential for the pool org survives the claim.
 */

export const WARM_CLAIM_KEY_PUSH_TIMEOUT_MS = 10_000;

/**
 * The safe-to-log correlation prefix length for a minted `eliza_` key. Matches
 * the platform's `API_KEY_PREFIX_LENGTH` intent (a short opaque prefix that
 * identifies the key row without revealing the secret). Kept local so this
 * module has no import that would pull the DB layer into the agent bundle.
 */
export const WARM_CLAIM_KEY_LOG_PREFIX_LEN = 12;

export interface WarmClaimKeyPushBody {
  apiKey: string;
  organizationId: string;
  userId?: string;
  forceInferenceEnabled: true;
}

/**
 * Build the `POST /api/cloud/login/persist` request body for a warm-claim
 * re-credential. Returns null when there is no usable key/org to push (caller
 * skips the push — the claim still succeeds and the key applies on the next
 * container boot from the row's env).
 */
export function buildWarmClaimKeyPushBody(params: {
  apiKey: string | null | undefined;
  organizationId: string | null | undefined;
  userId?: string | null | undefined;
}): WarmClaimKeyPushBody | null {
  const apiKey = params.apiKey?.trim();
  const organizationId = params.organizationId?.trim();
  if (!apiKey || !organizationId) return null;
  const userId = params.userId?.trim();
  return {
    apiKey,
    organizationId,
    ...(userId ? { userId } : {}),
    forceInferenceEnabled: true,
  };
}

/** A key prefix safe to place in logs/events. Never log the full key. */
export function safeKeyPrefix(apiKey: string): string {
  return `${apiKey.slice(0, WARM_CLAIM_KEY_LOG_PREFIX_LEN)}…`;
}
