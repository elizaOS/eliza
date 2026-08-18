/**
 * Side-effect-free history policy shared by Worker Durable Objects and the
 * canonical Postgres repository. Both stores use this exact merge so a late
 * mirror, retry, or direct writer converges instead of replacing newer turns.
 */

import { stringToUuid } from "@elizaos/core/edge";
import type { ModelMessage } from "ai";
import type {
  SharedRuntimeHistoryMessage,
  SharedRuntimePublicGrounding,
} from "../../../db/schemas/shared-runtime-history";

export const MAX_HISTORY_MESSAGES = 40;
export const MAX_PUBLIC_WEB_GROUNDING_QUERY_BYTES = 512;
export const MAX_PUBLIC_WEB_GROUNDING_RESULT_BYTES = 4_000;
export const MAX_PUBLIC_WEB_GROUNDING_ENCODED_BYTES = 6_000;

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
const GROUNDING_STOP_WORDS = new Set([
  "and",
  "are",
  "for",
  "from",
  "have",
  "how",
  "that",
  "the",
  "this",
  "was",
  "what",
  "when",
  "where",
  "which",
  "who",
  "with",
  "you",
]);
const DEICTIC_GROUNDING_FOLLOW_UP =
  /\b(?:it|that|this|those|these|they|them|result|results|source|sources|finding|findings|corrected|correction)\b/i;
const encoder = new TextEncoder();

export type SharedRuntimeHistoryMessageLike = SharedRuntimeHistoryMessage;

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const trimmed = value.trim();
  if (encoder.encode(trimmed).byteLength <= maxBytes) {
    return { value: trimmed, truncated: false };
  }
  let low = 0;
  let high = trimmed.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (encoder.encode(trimmed.slice(0, middle)).byteLength <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return { value: trimmed.slice(0, low), truncated: true };
}

/** Rejects malformed provenance and independently bounds every persisted field. */
export function parseSharedPublicWebGrounding(
  value: unknown,
): SharedRuntimePublicGrounding | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.kind !== "web_search" ||
    typeof candidate.query !== "string" ||
    (candidate.provider !== "parallel" && candidate.provider !== "exa") ||
    typeof candidate.text !== "string" ||
    typeof candidate.observedAt !== "number" ||
    !Number.isSafeInteger(candidate.observedAt) ||
    candidate.observedAt < 0 ||
    typeof candidate.truncated !== "boolean"
  ) {
    return undefined;
  }
  const query = truncateUtf8(candidate.query, MAX_PUBLIC_WEB_GROUNDING_QUERY_BYTES);
  const text = truncateUtf8(candidate.text, MAX_PUBLIC_WEB_GROUNDING_RESULT_BYTES);
  if (!query.value || !text.value) return undefined;
  return {
    kind: "web_search",
    query: query.value,
    provider: candidate.provider,
    text: text.value,
    observedAt: candidate.observedAt,
    truncated: candidate.truncated || query.truncated || text.truncated,
  };
}

/** Encodes untrusted evidence as JSON so result text cannot forge envelope boundaries. */
export function encodeSharedPublicWebGrounding(value: SharedRuntimePublicGrounding): string {
  const parsed = parseSharedPublicWebGrounding(value);
  if (!parsed) throw new TypeError("Invalid Shared public web grounding");
  let text = parsed.text;
  for (;;) {
    const encoded = JSON.stringify({
      type: "untrusted_public_web_search_result",
      instructionPolicy: "data_only",
      ...parsed,
      text,
      truncated: parsed.truncated || text.length < parsed.text.length,
    });
    if (encoder.encode(encoded).byteLength <= MAX_PUBLIC_WEB_GROUNDING_ENCODED_BYTES) {
      return encoded;
    }
    text = truncateUtf8(text, Math.max(0, encoder.encode(text).byteLength - 256)).value;
  }
}

/** Extracts only a successful Worker-safe public read for durable follow-up grounding. */
export function sharedPublicWebGrounding(
  actionResults: readonly unknown[] | undefined,
): SharedRuntimePublicGrounding | undefined {
  for (let index = (actionResults?.length ?? 0) - 1; index >= 0; index -= 1) {
    const candidate = actionResults?.[index];
    if (!candidate || typeof candidate !== "object") continue;
    const record = candidate as { success?: unknown; data?: unknown };
    if (record.success !== true || !record.data || typeof record.data !== "object") continue;
    const data = record.data as Record<string, unknown>;
    if (data.actionName !== "WEB_SEARCH") continue;
    return parseSharedPublicWebGrounding({
      kind: "web_search",
      query: data.query,
      provider: data.provider,
      text: data.value,
      observedAt: Date.now(),
      truncated: data.truncated === true,
    });
  }
  return undefined;
}

/** Converts one durable turn into the visible text shown to either model path. */
export function sharedRuntimeModelHistoryContent(message: SharedRuntimeHistoryMessageLike): string {
  return message.role === "assistant" && message.interrupted
    ? `[interrupted assistant partial]\n${message.content}`
    : message.content;
}

function groundingWords(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .match(/[\p{L}\p{N}]+/gu)
      ?.filter((word) => word.length > 2 && !GROUNDING_STOP_WORDS.has(word)) ?? [],
  );
}

function selectedGroundingIndices(
  history: SharedRuntimeHistoryMessageLike[],
  queryText: string,
): Set<number> {
  const query = groundingWords(queryText);
  const ranked = history.flatMap((message, index) => {
    const grounding =
      message.role === "assistant" ? parseSharedPublicWebGrounding(message.grounding) : undefined;
    if (!grounding) return [];
    const trustedWords = groundingWords(`${message.content}\n${grounding.query}`);
    let overlap = 0;
    for (const word of query) if (trustedWords.has(word)) overlap += 1;
    const immediate = index === history.length - 1;
    return overlap > 0 || (immediate && DEICTIC_GROUNDING_FOLLOW_UP.test(queryText))
      ? [{ index, overlap }]
      : [];
  });
  return new Set(
    ranked
      .sort((left, right) => right.overlap - left.overlap || right.index - left.index)
      .slice(0, 2)
      .map(({ index }) => index),
  );
}

/** Projects selected evidence as native tool results while keeping assistant prose separate. */
export function sharedRuntimeModelHistoryMessages(
  history: SharedRuntimeHistoryMessageLike[],
  queryText: string,
): ModelMessage[] {
  const selected = selectedGroundingIndices(history, queryText);
  const messages: ModelMessage[] = [];
  for (const [index, message] of history.entries()) {
    const grounding = selected.has(index)
      ? parseSharedPublicWebGrounding(message.grounding)
      : undefined;
    if (grounding) {
      const toolCallId = `persisted-web-${stringToUuid(`shared:${messageIdentity(message)}`)}`;
      messages.push({
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId,
            toolName: "WEB_SEARCH",
            input: { query: grounding.query },
          },
        ],
      });
      messages.push({
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId,
            toolName: "WEB_SEARCH",
            output: { type: "text", value: encodeSharedPublicWebGrounding(grounding) },
          },
        ],
      });
    }
    messages.push({ role: message.role, content: sharedRuntimeModelHistoryContent(message) });
  }
  return messages;
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
  const grounding = parseSharedPublicWebGrounding(message.grounding);
  const words = meaningfulWords(`${message.content}\n${grounding?.query ?? ""}`);
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
  const chosen = incoming;
  if (current.role !== "assistant" || incoming.role !== "assistant") return chosen;
  const currentGrounding = parseSharedPublicWebGrounding(current.grounding);
  const incomingGrounding = parseSharedPublicWebGrounding(incoming.grounding);
  if (!currentGrounding && !incomingGrounding) return chosen;
  if (!currentGrounding) return { ...chosen, grounding: incomingGrounding };
  if (!incomingGrounding) return { ...chosen, grounding: currentGrounding };
  const grounding =
    incomingGrounding.observedAt > currentGrounding.observedAt ||
    (incomingGrounding.observedAt === currentGrounding.observedAt &&
      encodeSharedPublicWebGrounding(incomingGrounding) >
        encodeSharedPublicWebGrounding(currentGrounding))
      ? incomingGrounding
      : currentGrounding;
  return { ...chosen, grounding };
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
