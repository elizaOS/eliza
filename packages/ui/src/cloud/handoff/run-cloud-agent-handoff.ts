import {
  CLOUD_HANDOFF_RETRY_EVENT,
  type CloudHandoffRetryDetail,
  dispatchCloudHandoffPhase,
} from "../../events";
import type { ConversationHandoffResult } from "./conversation-handoff";

/**
 * Run the shared→dedicated cloud-agent handoff and surface its lifecycle as
 * {@link dispatchCloudHandoffPhase} events: `migrating` up front, then the
 * terminal status the supervisor returns (or `failed` if it throws).
 *
 * On a non-success terminal phase (`timed-out`/`failed`) it arms a one-shot
 * retry: a {@link CLOUD_HANDOFF_RETRY_EVENT} for this `agentId` re-invokes
 * `start`. The supervisor's import is idempotent, so retrying is safe and the
 * user is never silently stranded on the shared adapter — the failure stays
 * visible with a retry instead of being swallowed (the old
 * `startCloudAgentHandoff(...).catch(() => {})`).
 *
 * `start` is a thunk so the caller owns the supervisor args (agent id, bases,
 * token, `onSwitch` rebind) and this module stays decoupled + unit-testable.
 *
 * `onSwitchSucceeded` is the gated success hook (PR4): it fires ONLY on a
 * terminal `switched`/`switched-empty` — i.e. the dedicated is confirmed live
 * and the transcript was copied + the client repointed onto it. It is the ONLY
 * safe moment to delete the transient shared bridge; on `timed-out`/`failed`
 * (or a thrown supervisor) the user is STILL on the shared adapter, so the hook
 * is deliberately NOT called and the shared bridge is kept. Best-effort: a
 * throw here is swallowed (a failed shared-delete just leaks a row — never
 * un-switches the user).
 */
export function runCloudAgentHandoff(
  agentId: string,
  start: () => Promise<ConversationHandoffResult>,
  onSwitchSucceeded?: () => void | Promise<void>,
): void {
  dispatchCloudHandoffPhase({ agentId, phase: "migrating" });
  start()
    .then((result) => {
      dispatchCloudHandoffPhase({
        agentId,
        phase: result.status,
        imported: result.imported,
        ...(result.error ? { error: result.error } : {}),
      });
      if (result.status === "timed-out" || result.status === "failed") {
        armRetry(agentId, start, onSwitchSucceeded);
        return;
      }
      // Terminal SUCCESS (`switched`/`switched-empty`): the dedicated is live,
      // the transcript is on it, and the client already repointed. Now — and
      // ONLY now — is the shared bridge safe to delete.
      void Promise.resolve(onSwitchSucceeded?.()).catch(() => {
        // Fire-and-forget: a failed shared-delete leaks a row, never strands
        // the (already switched) user. The supervisor logs the detail.
      });
    })
    .catch((err: unknown) => {
      dispatchCloudHandoffPhase({
        agentId,
        phase: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
      armRetry(agentId, start, onSwitchSucceeded);
    });
}

function armRetry(
  agentId: string,
  start: () => Promise<ConversationHandoffResult>,
  onSwitchSucceeded?: () => void | Promise<void>,
): void {
  if (typeof window === "undefined") return;
  const onRetry = (event: Event) => {
    const detail = (event as CustomEvent<CloudHandoffRetryDetail>).detail;
    if (detail?.agentId !== agentId) return;
    window.removeEventListener(CLOUD_HANDOFF_RETRY_EVENT, onRetry);
    // Thread the gated delete through the retry: a handoff that fails first and
    // succeeds on retry must still delete the shared bridge on the success leg.
    runCloudAgentHandoff(agentId, start, onSwitchSucceeded);
  };
  window.addEventListener(CLOUD_HANDOFF_RETRY_EVENT, onRetry);
}
