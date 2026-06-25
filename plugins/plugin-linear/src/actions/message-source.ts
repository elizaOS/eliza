import type { Memory } from "@elizaos/core";

export function getMessageSource(message: Memory): string | undefined {
  const source = message.content.source;
  return typeof source === "string" ? source : undefined;
}

export function formatUnknownError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  if (typeof error === "string") return error;
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return String(error);
  }
}
