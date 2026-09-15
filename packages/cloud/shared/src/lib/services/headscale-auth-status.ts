/**
 * Headscale mesh-join auth status classification.
 *
 * Shared source of truth between the container entrypoint
 * (packages/app-core/scripts/docker-entrypoint.sh) and the control plane. When
 * a container cannot join the mesh because its baked pre-auth key has expired /
 * been consumed AND it could not reconnect on a persisted node identity, the
 * entrypoint:
 *   1. exits with {@link TS_AUTHKEY_EXPIRED_EXIT_CODE} (78, EX_CONFIG), and
 *   2. writes {@link TS_AUTHKEY_EXPIRED_MARKER_BASENAME} into TS_STATE_DIR.
 *
 * The control plane keys off either signal to classify the container
 * `auth_expired` and drive a re-key/recreate instead of leaving it in an
 * unbounded `unless-stopped` restart loop (the prod-2 hard-reset outage:
 * de-authorized nodes fell back to a 60-min key that had expired months
 * earlier, so every restart replayed the same doomed `tailscale up`).
 *
 * This module is intentionally pure (no I/O): callers pass the container's
 * inspect/log evidence they already collect, and it returns a verdict.
 */

/**
 * Distinct exit code the entrypoint uses for "auth key expired/rejected and no
 * persisted identity could reconnect." 78 == EX_CONFIG (sysexits.h): the
 * *config* (the key) is stale, the image is fine — so the control plane re-keys
 * rather than treating it as a generic crash. MUST stay in lockstep with
 * `TS_AUTHKEY_EXPIRED_EXIT_CODE` in the entrypoint scripts.
 */
export const TS_AUTHKEY_EXPIRED_EXIT_CODE = 78;

/**
 * Marker file (relative to TS_STATE_DIR) the entrypoint drops when it hits the
 * auth-expired terminal state. MUST stay in lockstep with the entrypoint
 * scripts' `authkey-expired` path.
 */
export const TS_AUTHKEY_EXPIRED_MARKER_BASENAME = "authkey-expired";

/**
 * Log substrings that indicate a container failed to join the mesh because its
 * auth key is unusable. Lower-cased before matching. Mirrors the entrypoint's
 * `ts_authkey_permanent_failure` set plus the raw tailscaled phrasings the
 * container surfaces in `docker logs`.
 */
const AUTH_EXPIRED_LOG_PATTERNS: readonly string[] = [
  "authkey expired",
  "auth key expired",
  "key expired",
  "authkey already used",
  "auth key already used",
  "invalid key",
  "invalid authkey",
  "invalid auth key",
  // Tailscale 1.90 CLI JSON and daemon RegisterReq logs expose these when
  // Headscale declines unattended pre-auth and requires interactive login.
  '"authurl": "http',
  '"authurl":"http',
  "authurl=true",
  "authurl is http",
  '"backendstate": "needsmachineauth"',
  '"backendstate":"needsmachineauth"',
  "interactive authorization",
  // The distinct FATAL line the entrypoint prints before exiting 78.
  "node needs re-keying",
];

/** Evidence the control plane already gathers about a not-ready container. */
export interface ContainerAuthEvidence {
  /** `docker inspect` `.State.ExitCode`, when the container has exited. */
  exitCode?: number | null;
  /** Whether the entrypoint's auth-expired marker file is present in TS_STATE_DIR. */
  markerPresent?: boolean;
  /** Recent `docker logs` output (stdout+stderr), if collected. */
  logs?: string | null;
}

export type MeshAuthVerdict = "auth_expired" | "unknown";

/**
 * Classify whether a not-ready container is stuck specifically on expired mesh
 * auth. Returns `auth_expired` when ANY unambiguous signal is present:
 *   - the entrypoint's distinct exit code, OR
 *   - its marker file, OR
 *   - an auth-expired phrase in the container logs.
 *
 * Any other state is `unknown` — this function only ever *promotes* to
 * `auth_expired` on positive evidence, so it can never mask an unrelated
 * failure as a re-key candidate.
 */
export function classifyMeshAuthStatus(evidence: ContainerAuthEvidence): MeshAuthVerdict {
  if (evidence.exitCode === TS_AUTHKEY_EXPIRED_EXIT_CODE) {
    return "auth_expired";
  }
  if (evidence.markerPresent === true) {
    return "auth_expired";
  }
  const logs = evidence.logs;
  if (typeof logs === "string" && logs.length > 0) {
    const lower = logs.toLowerCase();
    if (AUTH_EXPIRED_LOG_PATTERNS.some((pattern) => lower.includes(pattern))) {
      return "auth_expired";
    }
  }
  return "unknown";
}

/** Convenience predicate for callers that only need the boolean. */
export function isMeshAuthExpired(evidence: ContainerAuthEvidence): boolean {
  return classifyMeshAuthStatus(evidence) === "auth_expired";
}
