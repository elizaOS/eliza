/**
 * Side-effect-free history policy shared by Worker Durable Objects and the
 * canonical Postgres repository. Both stores use this exact merge so a late
 * mirror, retry, or direct writer converges instead of replacing newer turns.
 */

export const MAX_HISTORY_MESSAGES = 40;

const RECENT_CONTEXT_MESSAGES = 24;
const MEMORY_HINT =
  /\b(?:remember|my\s+.+\s+is|i\s+(?:like|love|prefer|hate|need|want|am|have)|allerg|birthday|anniversary|favorite|favourite)\b/i;
const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "at",
  "be",
  "did",
  "do",
  "for",
  "from",
  "had",
  "have",
  "how",
  "i",
  "in",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "that",
  "the",
  "this",
  "to",
  "was",
  "we",
  "what",
  "when",
  "where",
  "which",
  "who",
  "with",
  "you",
]);

export interface SharedRuntimeHistoryMessageLike {
  id?: string;
  role: "system" | "user" | "assistant";
  content: string;
  source?: string;
  channelType?: string;
  createdAt?: number;
  interrupted?: boolean;
}

function isPersistedMessage(value: unknown): value is SharedRuntimeHistoryMessageLike {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    ((value as { role?: unknown }).role === "system" ||
      (value as { role?: unknown }).role === "user" ||
      (value as { role?: unknown }).role === "assistant") &&
    typeof (value as { content?: unknown }).content === "string" &&
    (value as { content: string }).content.trim().length > 0
  );
}

function messageIdentity(message: SharedRuntimeHistoryMessageLike): string {
  return message.id ?? `${message.role}\u0000${message.createdAt ?? ""}\u0000${message.content}`;
}

function meaningfulWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((word) => word.length > 2 && !STOP_WORDS.has(word)) ?? [],
  );
}

function relevanceScore(query: Set<string>, message: SharedRuntimeHistoryMessageLike): number {
  if (query.size === 0) return 0;
  const words = meaningfulWords(message.content);
  let overlap = 0;
  for (const word of query) {
    if (words.has(word)) overlap += 1;
  }
  return overlap * (message.role === "user" ? 2 : 1);
}

/**
 * Selects a bounded model context from an unbounded personal transcript.
 * Recent turns remain contiguous while older user facts and lexical matches
 * bring their adjacent reply along. The complete transcript stays durable and
 * is returned separately for history views and Dedicated cutover.
 */
export function selectSharedRuntimeContext<T extends SharedRuntimeHistoryMessageLike>(
  history: T[],
  queryText: string,
  limit = MAX_HISTORY_MESSAGES,
): T[] {
  const valid = history.filter(isPersistedMessage);
  if (valid.length <= limit) return valid;

  const recentStart = Math.max(0, valid.length - Math.min(RECENT_CONTEXT_MESSAGES, limit));
  const selected = new Set<number>();
  for (let index = recentStart; index < valid.length; index += 1) selected.add(index);

  const query = meaningfulWords(queryText);
  const older = valid
    .slice(0, recentStart)
    .map((message, index) => ({
      index,
      score: relevanceScore(query, message) + (MEMORY_HINT.test(message.content) ? 1 : 0),
    }))
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score || b.index - a.index);

  for (const candidate of older) {
    if (selected.size >= limit) break;
    selected.add(candidate.index);
    const adjacent =
      valid[candidate.index].role === "user" ? candidate.index + 1 : candidate.index - 1;
    if (adjacent >= 0 && adjacent < recentStart && selected.size < limit) {
      selected.add(adjacent);
    }
  }

  return [...selected].sort((a, b) => a - b).map((index) => valid[index]);
}

function chooseMergedMessage<T extends SharedRuntimeHistoryMessageLike>(
  current: T | undefined,
  incoming: T,
): T {
  if (!current) return incoming;
  if (
    current.role === "assistant" &&
    incoming.role === "assistant" &&
    current.interrupted !== true &&
    incoming.interrupted === true
  ) {
    return current;
  }
  if (
    current.role === "assistant" &&
    incoming.role === "assistant" &&
    current.interrupted === true &&
    incoming.interrupted === true &&
    current.content.length > incoming.content.length
  ) {
    return current;
  }
  return incoming;
}

export function mergeSharedRuntimeHistoryMessages<T extends SharedRuntimeHistoryMessageLike>(
  current: T[],
  incoming: T[],
  limit: number,
): T[] {
  const merged = new Map<string, T>();
  for (const message of [...current, ...incoming]) {
    if (!isPersistedMessage(message)) continue;
    const key = messageIdentity(message);
    merged.set(key, chooseMergedMessage(merged.get(key), message));
  }
  return [...merged.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0)).slice(-limit);
}
