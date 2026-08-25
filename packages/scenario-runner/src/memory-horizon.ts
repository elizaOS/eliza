/**
 * Defines the supported planted-conversation horizons and validates evaluator
 * configuration before a runtime or database is started.
 */

export const MEMORY_HORIZON_SIZES = [500, 1_000, 5_000, 10_000] as const;

export type MemoryHorizonSize = (typeof MEMORY_HORIZON_SIZES)[number];

export type ParsedMemoryHorizonSize =
  | { kind: "valid"; size: MemoryHorizonSize }
  | { kind: "invalid"; reason: string };

export function parseMemoryHorizonSize(
  value: string | undefined,
): ParsedMemoryHorizonSize {
  if (value === undefined || value.trim() === "") {
    return { kind: "valid", size: MEMORY_HORIZON_SIZES[0] };
  }
  if (!/^\d+$/.test(value)) {
    return {
      kind: "invalid",
      reason: `message horizon must be an integer, received ${JSON.stringify(value)}`,
    };
  }
  const parsed = Number(value);
  const matched = MEMORY_HORIZON_SIZES.find((size) => size === parsed);
  return matched === undefined
    ? {
        kind: "invalid",
        reason: `message horizon must be one of ${MEMORY_HORIZON_SIZES.join(", ")}, received ${parsed}`,
      }
    : { kind: "valid", size: matched };
}

export function memoryHorizonCorpusShape(size: MemoryHorizonSize): {
  conversationCount: 10;
  messagesPerConversation: number;
} {
  return {
    conversationCount: 10,
    messagesPerConversation: size / 10,
  };
}
