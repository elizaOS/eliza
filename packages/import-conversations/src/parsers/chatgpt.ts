/**
 * ChatGPT export parser (#11881 Track B).
 *
 * An official ChatGPT data export is a zip whose payload is a single
 * `conversations.json` — a JSON **array** of conversation objects. Each
 * conversation is a message **tree**: `mapping` holds `{ id, message, parent,
 * children }` nodes and `current_node` points at the active leaf. The active
 * thread is recovered by walking `current_node → parent` to the root and
 * reversing; regeneration branches simply are not on that path, so branch
 * pruning is implicit.
 *
 * Exports run 100 MB – 1 GB, so `parse` streams the top-level array element by
 * element (one conversation in memory at a time) rather than buffering the file
 * — see {@link streamJsonArrayElements}. The pure {@link flattenChatGptConversation}
 * is the testable heart: tree walk + node filtering + content flattening.
 *
 * Track A owns the {@link NormalizedConversation} contract this maps into.
 * See conversation-importer-scope.md §formats.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";

import type { ConversationImporter } from "../core/registry.ts";
import type {
  NormalizedAttachment,
  NormalizedConversation,
  NormalizedMessage,
  NormalizedRole,
} from "../core/types.ts";
import {
  readFirstJsonArrayObject,
  streamJsonArrayObjects,
} from "./json-array-stream.ts";
import { findZipEntryMetadata, openZipEntryStream } from "./zip-entry.ts";

const SOURCE = "chatgpt" as const;
const CONVERSATIONS_FILE = "conversations.json";

// --- Source shapes (partial — only the fields we read) ----------------------

interface ChatGptAuthor {
  role?: string;
  name?: string | null;
  metadata?: Record<string, unknown> | null;
}

interface ChatGptContent {
  content_type?: string;
  /** `text`: string[]; `multimodal_text`: (string | object)[]. */
  parts?: unknown[];
  /** `code` content type. */
  text?: string;
  language?: string;
}

interface ChatGptMessage {
  id?: string;
  author?: ChatGptAuthor | null;
  /** Epoch SECONDS (float). */
  create_time?: number | null;
  content?: ChatGptContent | null;
  /** Non-`all` recipient = tool-directed (function call / tool result). */
  recipient?: string | null;
  metadata?: {
    is_visually_hidden_from_conversation?: boolean;
    is_user_system_message?: boolean;
    model_slug?: string;
  } | null;
}

interface ChatGptNode {
  id?: string;
  message?: ChatGptMessage | null;
  parent?: string | null;
  children?: string[];
}

interface ChatGptConversation {
  title?: string;
  /** Epoch SECONDS (float). */
  create_time?: number | null;
  update_time?: number | null;
  mapping?: Record<string, ChatGptNode>;
  current_node?: string | null;
  conversation_id?: string;
  id?: string;
}

export type ChatGptParseOptions = {
  /**
   * Keep `system` messages that carry visible text (custom instructions can
   * land here). Off by default — most system nodes are empty/hidden roots.
   */
  includeSystem?: boolean;
};

const DEFAULT_OPTIONS: Required<ChatGptParseOptions> = {
  includeSystem: false,
};

// --- Content flattening -----------------------------------------------------

function secondsToMs(value: number | null | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.round(value * 1000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A recognizable attachment name for a non-text multimodal part. */
function attachmentFromPart(
  part: Record<string, unknown>,
): NormalizedAttachment | undefined {
  const contentType =
    typeof part.content_type === "string" ? part.content_type : undefined;
  const pointer =
    typeof part.asset_pointer === "string" ? part.asset_pointer : undefined;
  if (contentType === "image_asset_pointer" || pointer) {
    return {
      name: pointer ?? "image",
      kind: "image",
    };
  }
  return undefined;
}

/**
 * Flatten a single message's `content` into markdown-safe text plus any
 * attachments. Returns `null` when the content type is one we never surface as
 * transcript text (tool/browsing/execution output).
 */
function flattenContent(
  content: ChatGptContent | null | undefined,
): { text: string; attachments: NormalizedAttachment[] } | null {
  if (!content) return { text: "", attachments: [] };
  const type = content.content_type ?? "text";

  if (type === "text") {
    const parts = Array.isArray(content.parts) ? content.parts : [];
    const text = parts
      .filter((p): p is string => typeof p === "string")
      .join("\n\n")
      .trim();
    return { text, attachments: [] };
  }

  if (type === "code") {
    const code = typeof content.text === "string" ? content.text : "";
    if (!code.trim()) return { text: "", attachments: [] };
    const lang = typeof content.language === "string" ? content.language : "";
    return {
      text: `\`\`\`${lang}\n${code}\n\`\`\``,
      attachments: [],
    };
  }

  if (type === "multimodal_text") {
    const parts = Array.isArray(content.parts) ? content.parts : [];
    const textPieces: string[] = [];
    const attachments: NormalizedAttachment[] = [];
    for (const part of parts) {
      if (typeof part === "string") {
        if (part.trim()) textPieces.push(part);
        continue;
      }
      if (isRecord(part)) {
        const attachment = attachmentFromPart(part);
        if (attachment) {
          attachments.push(attachment);
          textPieces.push(`[${attachment.kind}: ${attachment.name}]`);
        }
      }
    }
    return { text: textPieces.join("\n\n").trim(), attachments };
  }

  // execution_output / tether_* / system_error / unknown → not transcript text.
  return null;
}

function normalizeRole(role: string | undefined): NormalizedRole | undefined {
  if (
    role === "user" ||
    role === "assistant" ||
    role === "system" ||
    role === "tool"
  ) {
    return role;
  }
  return undefined;
}

/**
 * Convert one tree node's message into a NormalizedMessage, or `undefined` when
 * it should be dropped: no message, unknown/tool role, tool-directed
 * (`recipient !== "all"`), hidden, or a system message when not requested. An
 * empty-text message with no attachments is also dropped.
 */
function nodeToMessage(
  node: ChatGptNode,
  opts: Required<ChatGptParseOptions>,
): NormalizedMessage | undefined {
  const message = node.message;
  if (!message) return undefined;

  const role = normalizeRole(message.author?.role);
  if (!role) return undefined;
  if (role === "tool") return undefined;
  if (role === "system" && !opts.includeSystem) return undefined;

  // Tool-directed turns (function calls / results) carry a non-"all" recipient.
  if (typeof message.recipient === "string" && message.recipient !== "all") {
    return undefined;
  }
  if (message.metadata?.is_visually_hidden_from_conversation) return undefined;

  const flattened = flattenContent(message.content);
  if (!flattened) return undefined;
  if (!flattened.text && flattened.attachments.length === 0) return undefined;

  const normalized: NormalizedMessage = {
    role,
    text: flattened.text,
  };
  if (message.id) normalized.sourceMessageId = message.id;
  const createdAt = secondsToMs(message.create_time);
  if (createdAt !== undefined) normalized.createdAt = createdAt;
  if (flattened.attachments.length > 0) {
    normalized.attachments = flattened.attachments;
  }
  return normalized;
}

/**
 * Walk the active thread from `current_node` up to the root and return the node
 * ids in chronological (root → leaf) order. Falls back to the newest leaf when
 * `current_node` is missing/dangling. A cycle guard bounds pathological input.
 */
function activeThreadNodeIds(conversation: ChatGptConversation): string[] {
  const mapping = conversation.mapping ?? {};
  let cursor = conversation.current_node ?? undefined;
  if (!cursor || !mapping[cursor]) {
    cursor = fallbackLeaf(mapping);
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  while (cursor && mapping[cursor] && !seen.has(cursor)) {
    seen.add(cursor);
    ids.push(cursor);
    cursor = mapping[cursor].parent ?? undefined;
  }
  return ids.reverse();
}

/** Newest leaf (node with a message and no children), by message create_time. */
function fallbackLeaf(
  mapping: Record<string, ChatGptNode>,
): string | undefined {
  let best: string | undefined;
  let bestTime = Number.NEGATIVE_INFINITY;
  for (const [id, node] of Object.entries(mapping)) {
    if (node.children && node.children.length > 0) continue;
    if (!node.message) continue;
    const time = node.message.create_time ?? 0;
    if (time >= bestTime) {
      bestTime = time;
      best = id;
    }
  }
  return best;
}

/**
 * Flatten one ChatGPT conversation object into a NormalizedConversation, or
 * `null` when it has no surfaced messages. Pure — the streaming/eager callers
 * both funnel through here.
 */
export function flattenChatGptConversation(
  conversation: ChatGptConversation,
  options?: ChatGptParseOptions,
): NormalizedConversation | null {
  const opts: Required<ChatGptParseOptions> = {
    ...DEFAULT_OPTIONS,
    ...options,
  };
  const mapping = conversation.mapping ?? {};

  const messages: NormalizedMessage[] = [];
  let model: string | undefined;
  for (const id of activeThreadNodeIds(conversation)) {
    const node = mapping[id];
    if (!node) continue;
    const message = nodeToMessage(node, opts);
    if (!message) continue;
    messages.push(message);
    if (!model && message.role === "assistant") {
      const slug = node.message?.metadata?.model_slug;
      if (typeof slug === "string" && slug) model = slug;
    }
  }

  if (messages.length === 0) return null;

  const sourceConversationId =
    conversation.conversation_id ?? conversation.id ?? "";
  if (!sourceConversationId) return null;

  const normalized: NormalizedConversation = {
    sourceConversationId,
    messages,
  };
  if (typeof conversation.title === "string" && conversation.title.trim()) {
    normalized.title = conversation.title.trim();
  }
  const createdAt = secondsToMs(conversation.create_time);
  if (createdAt !== undefined) normalized.createdAt = createdAt;
  const updatedAt = secondsToMs(conversation.update_time);
  if (updatedAt !== undefined) normalized.updatedAt = updatedAt;
  if (model) normalized.meta = { model };
  return normalized;
}

// --- Streaming top-level JSON array reader ----------------------------------

function isWhitespace(ch: string): boolean {
  return (
    ch === " " || ch === "\n" || ch === "\r" || ch === "\t" || ch === "﻿" // leading byte-order mark
  );
}

/**
 * Yield each top-level element of a JSON **array** from a stream of string
 * chunks, holding at most one element in memory at a time. A proper
 * string/escape/nesting state machine so braces inside string values do not
 * confuse depth tracking. Non-object elements are out of spec for a ChatGPT
 * export; malformed elements throw from `JSON.parse` and are handled by the
 * caller. This is what keeps a 1 GB `conversations.json` from being buffered.
 */
export async function* streamJsonArrayElements(
  chunks: AsyncIterable<string>,
): AsyncGenerator<unknown> {
  let buf = "";
  let pos = 0;
  let started = false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let elemStart = -1;

  for await (const chunk of chunks) {
    buf += chunk;
    while (pos < buf.length) {
      const ch = buf[pos];

      if (!started) {
        if (ch === "[") {
          started = true;
          pos++;
          continue;
        }
        if (isWhitespace(ch)) {
          pos++;
          continue;
        }
        throw new Error(
          "ChatGPT export: expected a top-level JSON array in conversations.json",
        );
      }

      if (elemStart === -1) {
        if (ch === "]") return;
        if (ch === "," || isWhitespace(ch)) {
          pos++;
          continue;
        }
        elemStart = pos; // element begins at this char; fall through to scan it
      }

      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') inString = false;
        pos++;
        continue;
      }
      if (ch === '"') {
        inString = true;
        pos++;
        continue;
      }
      if (ch === "{" || ch === "[") {
        depth++;
        pos++;
        continue;
      }
      if (ch === "}" || ch === "]") {
        depth--;
        pos++;
        if (depth === 0) {
          yield JSON.parse(buf.slice(elemStart, pos));
          buf = buf.slice(pos);
          pos = 0;
          elemStart = -1;
        }
        continue;
      }
      pos++;
    }

    // End of buffered input mid-scan: drop the already-consumed prefix when we
    // are between elements so memory stays bounded to the current element.
    if (elemStart === -1 && pos > 0) {
      buf = buf.slice(pos);
      pos = 0;
    }
  }
}

// --- ConversationImporter surface -------------------------------------------

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "ENOENT"
  );
}

async function resolveInput(
  input: string,
): Promise<
  { kind: "json"; path: string } | { kind: "zip"; path: string } | undefined
> {
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(input);
  } catch (error) {
    // error-policy:J3 an absent path is "not a ChatGPT export"; any other stat
    // failure (EACCES, EIO, ...) is a real I/O error on required input and must
    // surface rather than masquerade as an unrecognized/absent input.
    if (isNotFound(error)) return undefined;
    throw error;
  }

  if (st.isDirectory()) {
    const file = path.join(input, CONVERSATIONS_FILE);
    try {
      const fileStat = await stat(file);
      return fileStat.isFile() ? { kind: "json", path: file } : undefined;
    } catch (error) {
      // error-policy:J3 a missing conversations.json inside a directory means
      // "not a ChatGPT export"; a non-ENOENT failure reading it is a real I/O
      // error on required input and must surface.
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  if (!st.isFile()) return undefined;
  if (input.toLowerCase().endsWith(".zip")) return { kind: "zip", path: input };
  if (
    path.basename(input).toLowerCase() === CONVERSATIONS_FILE ||
    input.toLowerCase().endsWith(".json")
  ) {
    return { kind: "json", path: input };
  }
  return undefined;
}

async function openConversationsStream(input: string): Promise<Readable> {
  const resolved = await resolveInput(input);
  if (!resolved) {
    throw new Error(
      `ChatGPT export input must be a directory, ${CONVERSATIONS_FILE}, or .zip`,
    );
  }

  if (resolved.kind === "json") {
    return createReadStream(resolved.path);
  }

  return openZipEntryStream(resolved.path, CONVERSATIONS_FILE);
}

/**
 * detect: `input` is a ChatGPT export when it resolves to a readable
 * `conversations.json` whose first array element carries a `mapping` — the
 * signature that separates a ChatGPT tree export from a Claude linear export
 * (which has `chat_messages`).
 */
async function detect(input: string): Promise<boolean> {
  // Resolution decides recognition: an input that does not resolve to a ChatGPT
  // `conversations.json` (or a zip carrying one) is not a ChatGPT export and
  // returns false. Once it resolves, the payload is required input — a corrupt
  // or unreadable body throws so callers see a "corrupt ChatGPT export" failure
  // rather than a silent "unrecognized format".
  const resolved = await resolveInput(input);
  if (!resolved) return false;
  if (resolved.kind === "zip") {
    const metadata = await findZipEntryMetadata(
      resolved.path,
      CONVERSATIONS_FILE,
    );
    if (!metadata) return false;
  }

  const first = await readFirstJsonArrayObject(
    await openConversationsStream(input),
  );
  return isRecord(first) && isRecord((first as ChatGptConversation).mapping);
}

/**
 * parse: stream the export's `conversations.json` array, yielding one
 * NormalizedConversation per source conversation that has surfaced messages.
 * Conversations that flatten to nothing (all-tool/empty threads) are skipped.
 */
async function* parse(
  input: string,
  options?: ChatGptParseOptions,
): AsyncIterable<NormalizedConversation> {
  const source = await openConversationsStream(input);
  for await (const element of streamJsonArrayObjects(source)) {
    if (!isRecord(element)) continue;
    const conversation = flattenChatGptConversation(
      element as ChatGptConversation,
      options,
    );
    if (conversation) yield conversation;
  }
}

export const chatgptParser: ConversationImporter<string> = {
  source: SOURCE,
  detect,
  parse,
};

export { detect, parse };
export default chatgptParser;
