/**
 * Normalizes AI SDK token usage (prompt/completion or input/output naming) and
 * emits `EventType.MODEL_USED` so the runtime can meter each z.ai call.
 *
 * The emission is fire-and-forget but its rejection is captured: a faulty
 * MODEL_USED handler (metering/billing) must not convert an already-successful
 * model call into an unhandled rejection that terminates the process under
 * Node's default policy. Failures are warned and forwarded to
 * `runtime.reportError` (error-policy J7), matching the sibling zerollama guard.
 */
import type { IAgentRuntime, ModelTypeName } from "@elizaos/core";
import { EventType, logger } from "@elizaos/core";

type ModelUsage = {
  promptTokens?: number;
  completionTokens?: number;
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
};

export function emitModelUsageEvent(
  runtime: IAgentRuntime,
  type: ModelTypeName,
  usage: ModelUsage
): void {
  const promptTokens = usage.promptTokens ?? usage.inputTokens ?? 0;
  const completionTokens = usage.completionTokens ?? usage.outputTokens ?? 0;
  const totalTokens = usage.totalTokens ?? promptTokens + completionTokens;

  const emission = runtime.emitEvent(EventType.MODEL_USED, {
    runtime,
    source: "zai",
    type,
    tokens: {
      prompt: promptTokens,
      completion: completionTokens,
      total: totalTokens,
    },
  });
  void Promise.resolve(emission).catch((error) => {
    // error-policy:J7 usage telemetry must not turn a successful model call
    // into a failure; report it through the runtime diagnostics channel.
    logger.warn(
      `[z.ai] MODEL_USED emission failed: ${error instanceof Error ? error.message : String(error)}`
    );
    runtime.reportError("plugin-zai.model-usage", error, { type });
  });
}
