/**
 * Administrative-stop marker for ACP sessions.
 *
 * When the orchestrator tears a session down for lifecycle reasons (task
 * archive/delete/pause, user stop, API stop) rather than the session dying on
 * its own, downstream consumers must be able to tell the two apart: the swarm
 * coordinator suppresses its "stopped before completion" synthesis for marked
 * stops (the stop is plumbing the user already caused). An UNMARKED stop
 * (crash, subprocess death, genuine user-visible failure) must keep
 * synthesizing — the #11689 never-silent-terminal invariant.
 *
 * The marker is freshness-scoped (#22981): the stamp records when it was
 * written, and suppression honors it only within {@link ADMIN_STOP_MARKER_TTL_MS}
 * of that instant. Stop→`stopped` latency is seconds, so a marker old enough
 * to breach the window belongs to an administrative stop that failed to tear
 * the session down; honoring it would silence the survivor's later genuine
 * crash. A marker without a parseable timestamp is treated as stale for the
 * same reason — fail toward never-silent. Duplicate `stopped` events from one
 * teardown (the one-shot runner pattern) all land well inside the window and
 * stay suppressed.
 *
 * ONE definition of the keys lives here; do not add per-file literal copies.
 */

export const ADMIN_STOP_META_KEY = "adminStopReason";

/** ISO-8601 instant the admin-stop marker was stamped; pairs with the reason. */
export const ADMIN_STOP_STAMPED_AT_META_KEY = "adminStopStampedAt";

/**
 * Freshness window for honoring a stamp. Teardown `stopped` events follow the
 * stop within seconds; ten minutes is generous headroom for a wedged subprocess
 * while still bounding how long a stamped-but-failed stop can shadow a
 * surviving session's genuine terminal.
 */
export const ADMIN_STOP_MARKER_TTL_MS = 10 * 60_000;

/**
 * Whether a stamp taken at `stampedAt` (ISO-8601, from the session metadata)
 * still authorizes suppression at `nowMs`. Missing or unparseable timestamps
 * are stale: pre-#22981 stamps carry no timestamp, and the only such sessions
 * still alive to emit `stopped` are exactly the failed-stop survivors whose
 * terminals must synthesize.
 */
export function isAdminStopMarkerCurrent(
  stampedAt: string | undefined,
  nowMs: number,
): boolean {
  if (!stampedAt) return false;
  const stampedMs = Date.parse(stampedAt);
  if (Number.isNaN(stampedMs)) return false;
  return nowMs - stampedMs <= ADMIN_STOP_MARKER_TTL_MS;
}

/**
 * Best-effort stamp of {@link ADMIN_STOP_META_KEY} (and its
 * {@link ADMIN_STOP_STAMPED_AT_META_KEY} instant) onto the session's metadata
 * via `AcpService.updateSessionMetadata` (which merges the patch into the
 * store snapshot the coordinator's fresh-metadata re-read observes). Never
 * throws and never blocks the stop that follows it: a failed stamp only costs
 * the suppression (the stop still synthesizes — fail-open toward the
 * never-silent invariant).
 */
export async function markSessionAdministrativelyStopped(
  service: {
    updateSessionMetadata?: (
      id: string,
      patch: Record<string, unknown>,
    ) => Promise<void>;
  },
  sessionId: string,
  reason: string,
  log?: (msg: string) => void,
): Promise<void> {
  if (typeof service.updateSessionMetadata !== "function") return;
  try {
    await service.updateSessionMetadata(sessionId, {
      [ADMIN_STOP_META_KEY]: reason,
      [ADMIN_STOP_STAMPED_AT_META_KEY]: new Date().toISOString(),
    });
  } catch (err) {
    // error-policy:J6 best-effort teardown stamp on a session already being
    // stopped; a missed stamp degrades to today's synthesized stop notice and
    // must never block the stop itself.
    log?.(
      `admin-stop stamp failed for session ${sessionId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
