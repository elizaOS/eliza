import type { Memory } from "@elizaos/core";

export function getMessageSource(message: Memory): string | undefined {
  const source = (message.content as { source?: unknown }).source;
  return typeof source === "string" ? source : undefined;
}

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
