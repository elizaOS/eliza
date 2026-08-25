/**
 * Total-order comparators used by the conversation HTTP routes to order
 * conversation summaries and message memories.
 *
 * Timestamps reaching these comparators come from persisted rows and untrusted
 * PATCH payloads, so a malformed `updatedAt` string or a non-numeric
 * `createdAt` can produce `NaN`. A comparator that returns `NaN` makes
 * `Array.prototype.sort` implementation-defined, which surfaces as an unstable
 * conversation list. Both comparators therefore coerce a non-finite timestamp
 * to `0` and break the resulting tie on id so the order stays deterministic.
 */

/** Conversation summary fields the recency comparator depends on. */
export interface ConversationSortInput {
  id: string;
  updatedAt: string;
}

/** Message-memory fields the createdAt comparator depends on. */
export interface MemorySortInput {
  id?: string;
  createdAt?: number;
}

function finiteOrZero(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * Orders conversations newest-updated first. An unparseable `updatedAt` sorts
 * as epoch 0 (oldest) rather than poisoning the comparison with `NaN`.
 */
export function compareConversationsByRecency(
  a: ConversationSortInput,
  b: ConversationSortInput,
): number {
  const bVal = finiteOrZero(new Date(b.updatedAt).getTime());
  const aVal = finiteOrZero(new Date(a.updatedAt).getTime());
  return bVal - aVal || a.id.localeCompare(b.id);
}

/**
 * Orders message memories oldest-created first, treating a missing or
 * non-finite `createdAt` as epoch 0 and tie-breaking on memory id.
 */
export function compareMemoriesByCreatedAt(
  a: MemorySortInput,
  b: MemorySortInput,
): number {
  const aCreated = finiteOrZero(a.createdAt);
  const bCreated = finiteOrZero(b.createdAt);
  return (
    aCreated - bCreated ||
    (a.id ? String(a.id) : "").localeCompare(b.id ? String(b.id) : "")
  );
}
