/** Classifies snapshot failures by recoverability and permanent data loss. Authentication and transient transport failures never imply authority to prune stored state. */

// HTTP statuses that make a snapshot fetch/restore fail for THIS snapshot in a
// way the current provision cannot retry away, so it must degrade to a fresh
// boot instead of bricking the agent (#15210): 401/403 (auth — a dead/rotated
// container or an unauthenticated/rotating token rejects every retry
// identically), 404 (endpoint or snapshot gone), 410 (gone). Everything else —
// 5xx, 408/429, network/timeout — can heal on a retry and must NOT appear here.
export const UNRECOVERABLE_SNAPSHOT_HTTP_STATUSES = new Set([401, 403, 404, 410]);

// The subset that is also PERMANENTLY LOST — the snapshot itself is gone and no
// later resume can restore it, so the dead backup chain should be pruned: 404
// (endpoint or snapshot gone) and 410 (gone). 401/403 are auth failures, which
// are RECOVERABLE (missing/rotating token — see #15263, where the incident 401
// was a healthy container whose restore push simply omitted the agent token),
// so they must degrade-but-PRESERVE the chain: never prune a snapshot a
// token-corrected resume could still restore (#15274).
export const PERMANENTLY_LOST_SNAPSHOT_HTTP_STATUSES = new Set([404, 410]);

// Anchored on the exact `fetchSnapshotState` / `pushState` throw shapes so only
// this file's snapshot HTTP throw sites classify — an unrelated error that
// merely embeds one of these strings does not.
export const SNAPSHOT_HTTP_ERROR_SHAPE =
  /^(?:Snapshot fetch failed|State restore failed): HTTP (\d{3})(?:\s|$)/;

/**
 * True only when a stored backup snapshot can never be applied, no matter how
 * many times the provision retries. An agent's identity, config, and durable
 * data live in the DB record; a snapshot holds only volatile in-memory session
 * state — so the designed degrade for an unrecoverable snapshot (#15210) is
 * "boot fresh, lose only the volatile session", never "brick the whole agent".
 * Two shapes qualify:
 *
 * - UNDECRYPTABLE: the AEAD auth tag fails to verify (corruption / wrong key /
 *   wrong AAD, surfaced by the core KMS as `AeadError`) or the KMS key
 *   version that encrypted it no longer exists (`KeyNotFoundError` — thrown
 *   only by the ephemeral `memory` KMS backend, which derives a fresh
 *   per-process key on every restart and thus orphans everything it previously
 *   encrypted). Matched by error class NAME rather than `instanceof` because
 *   `AeadError` is internal to the core KMS submodule (not exported) and this code
 *   runs bundled, where a cross-realm `instanceof` on a dependency's error
 *   class is unreliable.
 * - UNRETRIEVABLE / UNRESTORABLE: the snapshot fetch or restore push was
 *   rejected with an unrecoverable-for-this-provision HTTP status (see
 *   `UNRECOVERABLE_SNAPSHOT_HTTP_STATUSES`). The incident shape (HQ 14308, agent
 *   23766030): `State restore failed: HTTP 401 {"error":"Unauthorized"}` from a
 *   bridge URL — deterministic on every attempt of THIS provision, so retrying
 *   only re-failed it into status=error.
 *
 * Deliberately NARROW so it never swallows a recoverable failure: HTTP 5xx /
 * 408 / 429, network/timeout errors, a transient KMS error (the Steward
 * backend surfaces HTTP 5xx as a base `KmsError`, not `KeyNotFoundError`), and
 * DB/IO errors are NOT matched and still propagate — degrading on one of those
 * would silently discard state that a retry would have restored.
 *
 * NOTE: "unrecoverable for this provision" (boot fresh) is a strictly WIDER
 * classification than "permanently lost" (also prune the chain). A 401/403 is
 * unrecoverable here but the snapshot is NOT permanently lost — an auth failure
 * heals once the token is attached/rotated correctly (#15263), so
 * `isPermanentlyLostSnapshot` must gate any pruning, never this predicate.
 */
export function isUnrecoverableSnapshotError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AeadError" || error.name === "KeyNotFoundError") return true;
  // A size refusal is deliberately NOT unrecoverable-for-this-provision. It is
  // deterministic, so retrying is pointless — but the chain is intact and
  // restorable in principle, and the only reason it cannot be applied is a
  // limit WE chose. Degrading it to a fresh boot would discard recoverable
  // state; it gets its own terminal branch at each restore site instead, and
  // the one way past it is wake's explicit `forceFreshBoot` consent.
  const match = SNAPSHOT_HTTP_ERROR_SHAPE.exec(error.message);
  return match !== null && UNRECOVERABLE_SNAPSHOT_HTTP_STATUSES.has(Number(match[1]));
}

/**
 * True only when the snapshot is PERMANENTLY LOST — no later resume, on any
 * container with any token, can ever restore it — so the dead backup chain is
 * safe to prune. A strict SUBSET of `isUnrecoverableSnapshotError`:
 *
 * - The crypto shapes (`AeadError` / `KeyNotFoundError`): the bytes can never
 *   be decrypted again (corruption, or the ephemeral `memory` KMS key that
 *   encrypted them is gone), so the chain is genuinely dead.
 * - HTTP 404 (endpoint or snapshot gone) / 410 (gone): the snapshot resource
 *   itself no longer exists to fetch.
 *
 * Excludes 401/403: those are AUTH failures (missing/rotating token), which are
 * RECOVERABLE — pruning on one would silently, permanently discard a snapshot a
 * token-corrected resume could still restore (#15274 regression class). On an
 * auth failure we still degrade to a fresh boot (never brick), but we PRESERVE
 * the chain and let the next authenticated resume restore it.
 */
export function isPermanentlyLostSnapshot(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AeadError" || error.name === "KeyNotFoundError") return true;
  const match = SNAPSHOT_HTTP_ERROR_SHAPE.exec(error.message);
  return match !== null && PERMANENTLY_LOST_SNAPSHOT_HTTP_STATUSES.has(Number(match[1]));
}
