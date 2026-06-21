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
 */
export function runCloudAgentHandoff(
  agentId: string,
  start: () => Promise<ConversationHandoffResult>,
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
        armRetry(agentId, start);
      }
    })
    .catch((err: unknown) => {
      dispatchCloudHandoffPhase({
        agentId,
        phase: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
      armRetry(agentId, start);
    });
}

function armRetry(
  agentId: string,
  start: () => Promise<ConversationHandoffResult>,
): void {
  if (typeof window === "undefined") return;
  const onRetry = (event: Event) => {
    const detail = (event as CustomEvent<CloudHandoffRetryDetail>).detail;
    if (detail?.agentId !== agentId) return;
    window.removeEventListener(CLOUD_HANDOFF_RETRY_EVENT, onRetry);
    runCloudAgentHandoff(agentId, start);
  };
  window.addEventListener(CLOUD_HANDOFF_RETRY_EVENT, onRetry);
}
