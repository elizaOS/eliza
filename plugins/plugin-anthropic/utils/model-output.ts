/** Owns Anthropic model output-capacity selection and incomplete-finish rejection. */

import { ElizaError } from "@elizaos/core";

/** Return the documented output limit required by Anthropic's `max_tokens` field. */
export function getAnthropicModelOutputLimit(modelName: string): number {
  const name = modelName.toLowerCase();
  if (
    name === "claude-fable-5" ||
    name === "claude-opus-5" ||
    name === "claude-opus-4-8" ||
    name === "claude-opus-4-7" ||
    name === "claude-opus-4-6" ||
    name === "claude-sonnet-5" ||
    name === "claude-sonnet-4-6"
  ) {
    return 128_000;
  }
  return name.includes("opus-4") ? 32_000 : 64_000;
}

/** Reject Anthropic or Claude CLI output that ended only because a budget was exhausted. */
export function assertCompleteAnthropicGeneration(finishReason: string | undefined): void {
  if (!finishReason) return;
  const normalized = finishReason.trim().toLowerCase().replaceAll("-", "_");
  if (
    normalized !== "length" &&
    normalized !== "max_tokens" &&
    normalized !== "max_output_tokens" &&
    normalized !== "max_completion_tokens" &&
    normalized !== "stop_length"
  ) {
    return;
  }
  throw new ElizaError(
    "Anthropic reached its output boundary; refusing to return partial model output",
    {
      code: "MODEL_OUTPUT_INCOMPLETE",
      context: { provider: "anthropic", finishReason },
    }
  );
}
