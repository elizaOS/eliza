/** Rejects provider terminal states that mean the returned model output is only a prefix. */

import { assertModelOutputComplete, ElizaError } from "@elizaos/core";

/** Fail closed when Ollama or an AI SDK adapter reports an output-boundary stop. */
export function assertCompleteOllamaGeneration(
  finishReason: string | undefined,
  provider: "ollama" | "zerollama"
): void {
  assertModelOutputComplete({ finishReason, provider });
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
      code: "MODEL_OUTPUT_INCOMPLETE",
      context: { provider: "zerollama", finishReason: null },
    }
  );
}
