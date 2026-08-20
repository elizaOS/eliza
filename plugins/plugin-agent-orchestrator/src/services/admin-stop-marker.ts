/**
 * Administrative-stop marker for ACP sessions.
 *
 * When the orchestrator tears a session down for lifecycle reasons (task
 * archive/delete/pause, user stop, API stop) rather than the session dying on
 * its own, downstream consumers must be able to tell the two apart: the swarm
 * coordinator suppresses its "stopped before completion" synthesis for marked
 * stops (the stop is plumbing the user already caused), and the mid-task
 * forwarder drops marked sessions as a belt against stop-failure races. An
 * UNMARKED stop (crash, subprocess death, genuine user-visible failure) must
 * keep synthesizing — the #11689 never-silent-terminal invariant.
 *
 * ONE definition of the key lives here; do not add per-file literal copies.
 */

export const ADMIN_STOP_META_KEY = "adminStopReason";

/**
 * Best-effort stamp of {@link ADMIN_STOP_META_KEY} onto the session's
 * metadata via `AcpService.updateSessionMetadata` (which merges the patch
 * into the store snapshot the coordinator's fresh-metadata re-read observes).
 * Never throws and never blocks the stop that follows it: a failed stamp only
 * costs the suppression (the stop still synthesizes — fail-open toward the
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
