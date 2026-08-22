/**
 * Deterministic stage-1 routing for cancel/stop requests aimed at durable
 * coding work. The planner's model routing is not stable here: across live
 * runs the same "cancel all ur running coding tasks" variously produced
 * hallucinated candidate names, an APP action=stop with an invented run id,
 * or no usable candidate at all — each ending in a wrong or hedged reply
 * while the real TASKS stop machinery sat unused (live 2026-08-19). The
 * phrasing is unambiguous, so the candidate surface is narrowed structurally
 * instead of hoping the model picks the right tool.
 */
import type { Memory, ResponseHandlerEvaluator } from "@elizaos/core";

/** Cancel/stop verb followed (within a short window) by a durable-work noun.
 *  Plain media/app phrasing ("stop the music", "stop the timer app") carries
 *  none of these nouns and keeps its normal routing. */
const DURABLE_CANCEL_RE =
  /\b(?:cancel|stop|kill|abort|end)\b[\s\S]{0,40}\b(?:coding\s+)?(?:tasks?|(?:sub[- ]?)?agents?|jobs?|builds?|sessions?)\b/i;

function messageText(message: Memory): string {
  const content = message.content;
  return content && typeof content === "object" && "text" in content
    ? String((content as { text?: unknown }).text ?? "")
    : "";
}

export const durableCancelRoutingEvaluator: ResponseHandlerEvaluator = {
  name: "agent-orchestrator.durable-cancel-routing",
  description:
    "Routes cancel/stop-of-coding-work phrasing to the TASKS surface deterministically.",
  priority: 20,
  shouldRun: ({ message }) => DURABLE_CANCEL_RE.test(messageText(message)),
  evaluate: ({ messageHandler }) => {
    if (messageHandler.processMessage !== "RESPOND") return undefined;
    return {
      clearCandidateActions: true,
      addCandidateActions: ["TASKS", "TASKS_STOP_AGENT", "TASKS_CANCEL"],
      // TASKS' contextGate accepts automation; without it the planner can
      // reject the injected candidates as out-of-context.
      addContextSlices: ["automation"],
      debug: [
        "durable-work cancel phrasing: candidate surface narrowed to TASKS",
      ],
    };
  },
};
