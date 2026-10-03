import { compareMemoryIds } from "@elizaos/core";

/** Oldest first. Same-millisecond rows follow UUID order, matching the store. */
export function compareConversationMessages(
  left: { id: string; timestamp: number },
  right: { id: string; timestamp: number },
): number {
  if (left.timestamp !== right.timestamp)
    return left.timestamp - right.timestamp;
  return compareMemoryIds(left.id, right.id);
}
