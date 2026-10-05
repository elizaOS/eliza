/** Creates typed failures for group-chat corpus parsing and generation boundaries. */
import { ElizaError } from "@elizaos/core";

export function groupChatCorpusError(options: {
  code: string;
  message: string;
  context?: Record<string, unknown>;
  cause?: unknown;
}): ElizaError {
  return new ElizaError(options.message, {
    code: options.code,
    ...(options.cause === undefined ? {} : { cause: options.cause }),
    ...(options.context === undefined ? {} : { context: options.context }),
  });
}
