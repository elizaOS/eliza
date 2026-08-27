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
 *   - the container echoes back a sha-256 FINGERPRINT prefix of the key its
 *     runtime resolves post-swap (`appliedKeyFingerprint`), never key
 *     material — `warmClaimKeyFingerprint` is the shared derivation both
 *     sides compare;
 *   - the pool-org key the container BOOTED with is named for the DELETED
 *     pool row (`agent-sandbox:<poolRowId>`), so the claim-time mint cannot
 *     touch it; `pushClaimedWarmContainerInferenceKey` revokes it by
 *     `warm_pool_row_id` only after live fingerprint attestation is durable,
 *     and the row becomes ready only after that revocation succeeds.
 */

import { sha256Hex } from "../crypto/worker";

export const WARM_CLAIM_KEY_PUSH_TIMEOUT_MS = 10_000;
export const WARM_CLAIM_RECOVERY_FAILURE_PREFIX = "Warm-claim credential recovery failed:";

/**
 * A claimed sandbox is ineligible for image changes until its server-owned
 * handoff state records a live user-org credential attestation. Cold-created
 * sandboxes have no pool credential to replace and therefore bypass this gate.
 */
export function hasReadyWarmClaimCredential(
  sandbox: Pick<
    {
      claimed_at: Date | null;
      warm_claim_credential_state: "pending" | "attested" | "ready" | "failed" | null;
      warm_claim_attested_at: Date | null;
      warm_claim_source_pool_id: string | null;
      warm_claim_key_fingerprint: string | null;
      warm_claim_attested_environment_revision: number | null;
      environment_revision: number;
    },
    | "claimed_at"
    | "warm_claim_credential_state"
    | "warm_claim_attested_at"
    | "warm_claim_source_pool_id"
    | "warm_claim_key_fingerprint"
    | "warm_claim_attested_environment_revision"
    | "environment_revision"
  >,
): boolean {
  if (!sandbox.claimed_at) return true;
  return (
    sandbox.warm_claim_credential_state === "ready" &&
    sandbox.warm_claim_attested_at instanceof Date &&
    sandbox.warm_claim_source_pool_id === null &&
    Boolean(sandbox.warm_claim_key_fingerprint) &&
    sandbox.warm_claim_attested_environment_revision !== null &&
    sandbox.warm_claim_attested_environment_revision === sandbox.environment_revision
  );
}

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
 * re-credential. Null is an explicit validation failure; durable callers must
 * reject it rather than treating a missing key or organization as a successful
 * handoff.
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

/**
 * Hex length of the sha-256 prefix the container echoes as
 * `appliedKeyFingerprint` and the control plane compares. 16 hex chars
 * (64 bits) is ample for an equality check between two values derived from
 * the same secret, and reveals nothing recoverable about the key.
 */
export const WARM_CLAIM_KEY_FINGERPRINT_HEX_LEN = 16;

/**
 * Shared fingerprint derivation for the push-verification round trip: the
 * container computes this over the cloud key its runtime RESOLVES after the
 * swap, the control plane computes it over the key it MINTED, and equality
 * proves the running process applied the pushed credential (transport 200
 * alone cannot — the F0 lineage is "control plane believed, process didn't").
 * Uses Web Crypto so the same function runs on Workers, Node, and Bun.
 */
export async function warmClaimKeyFingerprint(apiKey: string): Promise<string> {
  return (await sha256Hex(apiKey)).slice(0, WARM_CLAIM_KEY_FINGERPRINT_HEX_LEN);
}
