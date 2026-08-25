/** Rejects provider terminal states that mean the returned model output is only a prefix. */

import { ElizaError } from "@elizaos/core";

/** Fail closed when Ollama or an AI SDK adapter reports an output-boundary stop. */
export function assertCompleteOllamaGeneration(
  finishReason: string | undefined,
  provider: "ollama" | "zerollama"
): void {
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
    `${provider} reached its output boundary; refusing to return partial model output`,
    {
      code: "MODEL_INCOMPLETE_OUTPUT",
      context: { provider, finishReason },
    }
  );
}

/** A native stream without a terminal event cannot prove that its text is complete. */
export function assertZerollamaStreamTerminated(finishReason: string | undefined): void {
  if (finishReason !== undefined) {
    assertCompleteOllamaGeneration(finishReason, "zerollama");
    return;
  }
  throw new ElizaError(
    "zerollama stream ended without a terminal event; refusing potentially partial model output",
    {
      code: "MODEL_INCOMPLETE_OUTPUT",
      context: { provider: "zerollama", finishReason: null },
    }
  );
}
