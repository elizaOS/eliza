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
import { logger } from "../../utils/logger";

export const MAX_HISTORY_MESSAGES = 40;
export const MAX_PUBLIC_WEB_GROUNDING_QUERY_BYTES = 512;
export const MAX_PUBLIC_WEB_GROUNDING_RESULT_BYTES = 4_000;
export const MAX_PUBLIC_WEB_GROUNDING_ENCODED_BYTES = 6_000;
export const MAX_PUBLIC_WEB_GROUNDING_AGE_MS = 24 * 60 * 60 * 1_000;
export const MAX_PUBLIC_WEB_GROUNDING_FUTURE_SKEW_MS = 5 * 60 * 1_000;

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
  "find",
  "found",
  "from",
  "have",
  "how",
  "result",
  "results",
  "search",
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
  /\b(?:it|that|this|those|these|they|them|result|results|source|sources|find|found|finding|findings|corrected|correction)\b/i;
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
  // Binary search indexes UTF-16 code units. Avoid persisting half of an
  // astral code point when the byte boundary lands after its high surrogate.
  const boundary = low > 0 && /[\uD800-\uDBFF]/u.test(trimmed[low - 1]) ? low - 1 : low;
  return { value: trimmed.slice(0, boundary), truncated: true };
}

/** Rejects malformed provenance and independently bounds every persisted field. */
export function parseSharedPublicWebGrounding(
  value: unknown,
): SharedRuntimePublicGrounding | undefined {
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    candidate.kind === "web_search_unavailable" &&
    typeof candidate.query === "string" &&
    typeof candidate.observedAt === "number" &&
    Number.isSafeInteger(candidate.observedAt) &&
    candidate.observedAt >= 0
  ) {
    const query = truncateUtf8(candidate.query, MAX_PUBLIC_WEB_GROUNDING_QUERY_BYTES);
    return query.value
      ? { kind: "web_search_unavailable", query: query.value, observedAt: candidate.observedAt }
      : undefined;
  }
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
  if (!parsed || parsed.kind !== "web_search") {
    throw new TypeError("Invalid Shared public web grounding");
  }
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
    const record = candidate as { success?: unknown; text?: unknown; data?: unknown };
    if (!record.data || typeof record.data !== "object") continue;
    const data = record.data as Record<string, unknown>;
    if (data.actionName !== "WEB_SEARCH") continue;
    const observedAt = Date.now();
    const parsed =
      record.success === true
        ? parseSharedPublicWebGrounding({
            kind: "web_search",
            query: data.query,
            provider: data.provider,
            text: record.text,
            observedAt,
            truncated: data.truncated === true,
          })
        : parseSharedPublicWebGrounding({
            kind: "web_search_unavailable",
            query: data.query,
            observedAt,
          });
    if (!parsed) {
      // error-policy:J7 A WEB_SEARCH result this turn just produced is our own
      // contract, not untrusted input: an unparseable envelope means the action
      // shape drifted. Report it instead of silently dropping the grounding,
      // which would degrade the follow-up into an ungrounded reply.
      logger.warn(
        "[sharedPublicWebGrounding] fresh WEB_SEARCH result failed grounding validation; dropping authority",
        {
          success: record.success === true,
          queryType: typeof data.query,
          providerValue: typeof data.provider === "string" ? data.provider : typeof data.provider,
          textType: typeof record.text,
        },
      );
    }
    return parsed;
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

type SelectedGrounding = {
  index: number;
  grounding: SharedRuntimePublicGrounding;
  status: "available" | "unavailable" | "fresh_search_required";
};

function selectedGrounding(
  history: SharedRuntimeHistoryMessageLike[],
  queryText: string,
  now: number,
): SelectedGrounding | undefined {
  const query = groundingWords(queryText);
  const candidates = history.flatMap((message, index) => {
    const grounding =
      message.role === "assistant" ? parseSharedPublicWebGrounding(message.grounding) : undefined;
    if (!grounding) return [];
    let precedingUserQuery = "";
    for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
      if (history[cursor].role !== "user") continue;
      precedingUserQuery = history[cursor].content;
      break;
    }
    // User text and the validated tool query are trusted selection inputs;
    // assistant prose and provider result text remain excluded.
    const trustedWords = groundingWords(`${precedingUserQuery}\n${grounding.query}`);
    let overlap = 0;
    for (const word of query) if (trustedWords.has(word)) overlap += 1;
    const immediate = !history
      .slice(index + 1)
      .some((laterMessage) => laterMessage.role === "user" || laterMessage.role === "assistant");
    return [{ index, overlap, immediate, grounding }];
  });
  const topical = candidates.filter((candidate) => candidate.overlap > 0);
  let ranked: typeof candidates = [];
  if (topical.length > 0) {
    // Overlap identifies the topic anchor, but the newest same-topic attempt
    // (a corrected search or an unavailable tombstone) is the authority even
    // when its shorter query overlaps the follow-up less than a stale result.
    const anchor = topical.reduce((best, candidate) => {
      const order =
        candidate.overlap - best.overlap ||
        candidate.grounding.observedAt - best.grounding.observedAt ||
        candidate.index - best.index;
      return order > 0 ? candidate : best;
    });
    const anchorQueryWords = groundingWords(anchor.grounding.query);
    ranked = topical
      .filter((candidate) => {
        if (candidate === anchor) return true;
        for (const word of groundingWords(candidate.grounding.query)) {
          if (anchorQueryWords.has(word)) return true;
        }
        return false;
      })
      .sort(
        (left, right) =>
          right.grounding.observedAt - left.grounding.observedAt || right.index - left.index,
      );
  } else if (DEICTIC_GROUNDING_FOLLOW_UP.test(queryText)) {
    ranked = candidates
      .filter((candidate) => candidate.immediate)
      .sort(
        (left, right) =>
          right.grounding.observedAt - left.grounding.observedAt || right.index - left.index,
      );
  }
  const latest = ranked[0];
  if (!latest) return undefined;
  if (latest.grounding.kind === "web_search_unavailable") {
    return { ...latest, status: "unavailable" };
  }
  if (
    latest.grounding.observedAt < now - MAX_PUBLIC_WEB_GROUNDING_AGE_MS ||
    latest.grounding.observedAt > now + MAX_PUBLIC_WEB_GROUNDING_FUTURE_SKEW_MS
  ) {
    return { ...latest, status: "fresh_search_required" };
  }
  return { ...latest, status: "available" };
}

function groundingAuthorityMarker(selection: SelectedGrounding): ModelMessage {
  return {
    role: "system",
    content: JSON.stringify({
      type: "public_web_search_authority",
      status: selection.status,
      policy: "do_not_use_prior_assistant_web_claims",
    }),
  };
}

/**
 * Shapes selected evidence for one provider request.
 *
 * `nativeToolProjection` must be false whenever the current request does not
 * declare `WEB_SEARCH` in its tool set: a strict provider rejects an entire
 * request whose history references an undeclared tool, which loses the turn
 * rather than only the grounding. The data-only user message carries the same
 * bounded, JSON-encoded evidence text without granting public content system
 * authority, and is valid on every provider.
 */
export interface SharedRuntimeGroundingProjectionOptions {
  nativeToolProjection?: boolean;
}

function groundingProjectionMessages(
  message: SharedRuntimeHistoryMessageLike,
  selection: SelectedGrounding,
  options?: SharedRuntimeGroundingProjectionOptions,
): ModelMessage[] {
  if (selection.status !== "available") return [groundingAuthorityMarker(selection)];
  if (selection.grounding.kind !== "web_search") return [];
  if (options?.nativeToolProjection === false) {
    return [
      groundingAuthorityMarker(selection),
      { role: "user", content: encodeSharedPublicWebGrounding(selection.grounding) },
    ];
  }
  const toolCallId = `persisted-web-${stringToUuid(`shared:${messageIdentity(message)}`)}`;
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId,
          toolName: "WEB_SEARCH",
          input: { query: selection.grounding.query },
        },
      ],
    },
    {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId,
          toolName: "WEB_SEARCH",
          output: {
            type: "text",
            value: encodeSharedPublicWebGrounding(selection.grounding),
          },
        },
      ],
    },
  ];
}

/**
 * Projects only canonical grounding authority derived from typed assistant
 * grounding. Persisted system and transcript strings never enter this result.
 */
export function sharedRuntimeGroundingProjectionMessages(
  history: SharedRuntimeHistoryMessageLike[],
  queryText: string,
  now = Date.now(),
  options?: SharedRuntimeGroundingProjectionOptions,
): ModelMessage[] {
  const selected = selectedGrounding(history, queryText, now);
  if (!selected) return [];
  const message = history[selected.index];
  return message ? groundingProjectionMessages(message, selected, options) : [];
}

/** Projects selected evidence as native tool results while keeping assistant prose separate. */
export function sharedRuntimeModelHistoryMessages(
  history: SharedRuntimeHistoryMessageLike[],
  queryText: string,
  now = Date.now(),
): ModelMessage[] {
  const selected = selectedGrounding(history, queryText, now);
  const messages: ModelMessage[] = [];
  for (const [index, message] of history.entries()) {
    if (selected?.index === index && selected.status === "available") {
      messages.push(...groundingProjectionMessages(message, selected));
    }
    messages.push({ role: message.role, content: sharedRuntimeModelHistoryContent(message) });
    if (selected?.index === index && selected.status !== "available") {
      messages.push(...groundingProjectionMessages(message, selected));
    }
  }
  return messages;
}

/** Inserts historical evidence without splitting a live tool call/result pair. */
export function insertSharedRuntimeGroundingMessages(
  messages: ModelMessage[],
  groundingMessages: ModelMessage[],
): ModelMessage[] {
  if (groundingMessages.length === 0) return messages;
  // Later planner iterations end in a live tool result, not the user's turn.
  // Anchor evidence before the last user message so the current tool pair
  // remains adjacent for providers that enforce message ordering.
  const currentUserIndex = messages.findLastIndex((message) => message.role === "user");
  if (currentUserIndex < 0) return messages;
  return [
    ...messages.slice(0, currentUserIndex),
    ...groundingMessages,
    ...messages.slice(currentUserIndex),
  ];
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
  // A grounded reply is recallable by what it says AND by what it searched for:
  // scoring the union keeps ordinary lexical recall intact while letting a
  // follow-up phrased like the original query find the reply that answered it.
  const words = meaningfulWords(
    message.role === "assistant" && grounding
      ? `${message.content}\n${grounding.query}`
      : message.content,
  );
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
      JSON.stringify(incomingGrounding) > JSON.stringify(currentGrounding))
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
