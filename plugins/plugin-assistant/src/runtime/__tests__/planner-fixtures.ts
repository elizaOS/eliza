/** Planner-loop context fixtures shared by the runtime tests. */
import type { ContextEvent, JsonValue } from "@elizaos/core";
import { ElizaError } from "@elizaos/core";

/** The Stage-1 decision event the message service records on a turn's context. */
export function stageOneEvent(
  metadata: Record<string, JsonValue>,
): ContextEvent {
  return {
    id: "stage1",
    type: "message_handler",
    source: "message-service",
    metadata,
  };
}

/** The error a provider adapter throws for a response that stopped before it was complete. */
export const modelOutputIncomplete = () =>
  new ElizaError(
    "[openai] Model output did not complete successfully (length).",
    {
      code: "MODEL_OUTPUT_INCOMPLETE",
      context: { provider: "openai", finishReason: "length" },
    },
  );
