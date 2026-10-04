/** Oldest first. Same-millisecond rows follow UUID order, matching the store. */
export function compareConversationMessages(
  left: { id: string; timestamp: number },
  right: { id: string; timestamp: number },
): number {
  if (left.timestamp !== right.timestamp)
    return left.timestamp - right.timestamp;
  const leftId = left.id.toLowerCase();
  const rightId = right.id.toLowerCase();
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}
