/**
 * Browser-safe conversation-import helpers for app UIs.
 *
 * The package root intentionally exports Node parsers for filesystem/zip inputs.
 * This subpath keeps browser importers on the canonical core contract without
 * pulling in node:fs, node:stream, or zip readers.
 */

import {
  collectImport,
  type RunImportResult,
  runImport,
} from "./core/pipeline.ts";
import { redactText, SECRET_VALUE_PATTERNS } from "./core/redact.ts";
import type { DocumentSink } from "./core/sink.ts";
import type {
  ConversationSource,
  NormalizedConversation,
  NormalizedMessage,
  NormalizedRole,
} from "./core/types.ts";

export {
  enumerateBatchDocumentIds,
  type ImportManifest,
} from "./core/manifest.ts";
export {
  type ProgressEvent,
  runImport,
  uninstallBatch,
} from "./core/pipeline.ts";
export type { ImportReport } from "./core/report.ts";
export type { DocumentSink, SinkDocument } from "./core/sink.ts";
export type {
  ConversationSource,
  NormalizedConversation,
  NormalizedMessage,
} from "./core/types.ts";

export type BrowserConversationImportSource =
  | "chatgpt"
  | "claude"
  | "hermes"
  | "openclaw";

export const BROWSER_CONVERSATION_IMPORT_SOURCES: readonly {
  value: BrowserConversationImportSource;
  label: string;
}[] = [
  { value: "chatgpt", label: "ChatGPT" },
  { value: "claude", label: "Claude" },
  { value: "hermes", label: "Hermes" },
  { value: "openclaw", label: "OpenClaw" },
] as const;

export interface BrowserConversationImportExample {
  title: string;
  role: NormalizedRole;
  text: string;
  createdAt?: number;
}

export interface BrowserConversationImportPreview {
  source: BrowserConversationImportSource;
  counts: {
    conversations: number;
    messages: number;
    documents: number;
    redactions: number;
  };
  examples: BrowserConversationImportExample[];
  warnings: string[];
}

export interface ParseConversationImportTextOptions {
  filename?: string;
}

export interface PreviewConversationImportTextOptions
  extends ParseConversationImportTextOptions {
  batchId?: string;
}

export interface RunConversationImportTextOptions
  extends ParseConversationImportTextOptions {
  source: BrowserConversationImportSource;
  rawText: string;
  batchId: string;
  sink: DocumentSink;
  entityId?: string;
  onProgress?: (progress: { done: number; total: number }) => void;
}

type RecordLike = Record<string, unknown>;

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(rawText: string, source: ConversationSource): unknown {
  try {
    return JSON.parse(rawText);
  } catch (error) {
    throw new Error(
      `${source} browser import expects a JSON export file; full filesystem/zip imports must use the Node parser.`,
      { cause: error },
    );
  }
}

function stringField(
  record: RecordLike,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function numberTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 10_000_000_000
      ? Math.round(value * 1000)
      : Math.round(value);
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function normalizeRole(value: unknown): NormalizedRole | undefined {
  const role =
    typeof value === "string"
      ? value
      : isRecord(value)
        ? stringField(value, ["role", "name"])
        : undefined;
  if (role === "human") return "user";
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

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromUnknown).join("\n");
  if (!isRecord(value)) return "";
  if (typeof value.text === "string") return value.text;
  if (typeof value.content === "string") return value.content;
  if (typeof value.message === "string") return value.message;
  if (Array.isArray(value.parts)) {
    return value.parts.map(textFromUnknown).join("\n");
  }
  if (Array.isArray(value.content)) {
    return value.content.map(textFromUnknown).filter(Boolean).join("\n\n");
  }
  return "";
}

function sourceArray(root: unknown): unknown[] {
  if (Array.isArray(root)) return root;
  if (isRecord(root)) {
    for (const key of ["conversations", "sessions"]) {
      const value = root[key];
      if (Array.isArray(value)) return value;
    }
  }
  return [];
}

function fallbackId(source: ConversationSource, index: number): string {
  return `${source}-conversation-${index + 1}`;
}

function messageFromParts(params: {
  role: unknown;
  text: unknown;
  createdAt?: unknown;
  sourceMessageId?: unknown;
}): NormalizedMessage | undefined {
  const role = normalizeRole(params.role);
  if (!role) return undefined;
  const text = textFromUnknown(params.text).trim();
  if (!text) return undefined;
  return {
    role,
    text,
    createdAt: numberTimestamp(params.createdAt),
    sourceMessageId:
      typeof params.sourceMessageId === "string"
        ? params.sourceMessageId
        : undefined,
  };
}

function activeChatGptNodeIds(
  mapping: Record<string, RecordLike>,
  currentNode: unknown,
): string[] {
  let cursor = typeof currentNode === "string" ? currentNode : undefined;
  if (!cursor || !mapping[cursor]) {
    for (const [id, node] of Object.entries(mapping)) {
      if (Array.isArray(node.children) && node.children.length > 0) continue;
      if (isRecord(node.message)) cursor = id;
    }
  }
  const ids: string[] = [];
  const seen = new Set<string>();
  while (cursor && mapping[cursor] && !seen.has(cursor)) {
    seen.add(cursor);
    ids.push(cursor);
    const parent = mapping[cursor]?.parent;
    cursor = typeof parent === "string" ? parent : undefined;
  }
  return ids.reverse();
}

function parseChatGptText(rawText: string): NormalizedConversation[] {
  return sourceArray(parseJson(rawText, "chatgpt"))
    .map((value, index): NormalizedConversation | undefined => {
      if (!isRecord(value)) return undefined;
      const messages: NormalizedMessage[] = [];
      if (isRecord(value.mapping)) {
        const mapping = value.mapping as Record<string, RecordLike>;
        for (const id of activeChatGptNodeIds(mapping, value.current_node)) {
          const node = mapping[id];
          const message = isRecord(node?.message) ? node.message : undefined;
          if (!message) continue;
          const content = isRecord(message.content)
            ? message.content
            : message.content;
          const normalized = messageFromParts({
            role: isRecord(message.author)
              ? message.author.role
              : message.author,
            text: content,
            createdAt: message.create_time,
            sourceMessageId: message.id,
          });
          if (normalized) messages.push(normalized);
        }
      } else if (Array.isArray(value.messages)) {
        for (const raw of value.messages) {
          if (!isRecord(raw)) continue;
          const normalized = messageFromParts({
            role: raw.author ?? raw.role,
            text: raw.content ?? raw.text,
            createdAt: raw.create_time ?? raw.created_at ?? raw.timestamp,
            sourceMessageId: raw.id,
          });
          if (normalized) messages.push(normalized);
        }
      }
      if (messages.length === 0) return undefined;
      return {
        sourceConversationId:
          stringField(value, ["conversation_id", "conversationId", "id"]) ??
          fallbackId("chatgpt", index),
        title: stringField(value, ["title", "name"]) ?? "ChatGPT conversation",
        createdAt: numberTimestamp(value.create_time ?? value.created_at),
        updatedAt: numberTimestamp(value.update_time ?? value.updated_at),
        messages,
      };
    })
    .filter((value): value is NormalizedConversation => Boolean(value));
}

function parseClaudeText(rawText: string): NormalizedConversation[] {
  return sourceArray(parseJson(rawText, "claude"))
    .map((value, index): NormalizedConversation | undefined => {
      if (!isRecord(value)) return undefined;
      const rawMessages = Array.isArray(value.chat_messages)
        ? value.chat_messages
        : Array.isArray(value.messages)
          ? value.messages
          : [];
      const messages = rawMessages
        .map((raw): NormalizedMessage | undefined => {
          if (!isRecord(raw)) return undefined;
          return messageFromParts({
            role: raw.sender ?? raw.role,
            text: raw.text ?? raw.content,
            createdAt: raw.created_at ?? raw.createdAt ?? raw.timestamp,
            sourceMessageId: raw.uuid ?? raw.id,
          });
        })
        .filter((message): message is NormalizedMessage => Boolean(message));
      if (messages.length === 0) return undefined;
      return {
        sourceConversationId:
          stringField(value, [
            "uuid",
            "id",
            "conversation_id",
            "conversationId",
          ]) ?? fallbackId("claude", index),
        title: stringField(value, ["name", "title"]) ?? "Claude conversation",
        createdAt:
          numberTimestamp(value.created_at ?? value.createdAt) ??
          messages[0]?.createdAt,
        updatedAt:
          numberTimestamp(value.updated_at ?? value.updatedAt) ??
          messages.at(-1)?.createdAt ??
          messages[0]?.createdAt,
        messages,
      };
    })
    .filter((value): value is NormalizedConversation => Boolean(value));
}

function parseHermesText(
  rawText: string,
  options: ParseConversationImportTextOptions,
): NormalizedConversation[] {
  const messages: NormalizedMessage[] = [];
  for (const line of rawText.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (!isRecord(parsed) || parsed.role === "session_meta") continue;
      const message = messageFromParts({
        role: parsed.role,
        text: parsed.content ?? parsed.text,
        createdAt: parsed.timestamp ?? parsed.created_at,
      });
      if (message) messages.push(message);
    } catch {
      throw new Error(
        "Hermes browser import expects a selected .jsonl session file; full home-directory imports must use the Node parser.",
      );
    }
  }
  if (messages.length === 0) return [];
  const id = options.filename?.replace(/\.jsonl$/iu, "") || "hermes-session";
  return [
    {
      sourceConversationId: id,
      title: `Hermes session ${id}`,
      createdAt: messages[0]?.createdAt,
      updatedAt: messages.at(-1)?.createdAt ?? messages[0]?.createdAt,
      messages,
    },
  ];
}

function parseOpenClawText(
  rawText: string,
  options: ParseConversationImportTextOptions,
): NormalizedConversation[] {
  const text = rawText.trim();
  if (!text) return [];
  const name = options.filename || "memory.md";
  const id = `markdown:${name.replace(/[^a-z0-9_.-]+/giu, "-").toLowerCase()}`;
  return [
    {
      sourceConversationId: id,
      title: `OpenClaw markdown import (${name})`,
      messages: [
        {
          role: "system",
          text,
          annotations: { toolName: "openclaw-markdown" },
        },
      ],
      meta: { tags: ["openclaw-memory", `file:${name}`] },
    },
  ];
}

export function parseConversationImportText(
  source: BrowserConversationImportSource,
  rawText: string,
  options: ParseConversationImportTextOptions = {},
): NormalizedConversation[] {
  switch (source) {
    case "chatgpt":
      return parseChatGptText(rawText);
    case "claude":
      return parseClaudeText(rawText);
    case "hermes":
      return parseHermesText(rawText, options);
    case "openclaw":
      return parseOpenClawText(rawText, options);
  }
}

function countRedactions(text: string): number {
  let redactions = 0;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    pattern.lastIndex = 0;
    text.replace(pattern, () => {
      redactions += 1;
      return "";
    });
  }
  return redactions;
}

async function* asAsync(
  conversations: readonly NormalizedConversation[],
): AsyncIterable<NormalizedConversation> {
  for (const conversation of conversations) yield conversation;
}

export async function previewConversationImportText(
  source: BrowserConversationImportSource,
  rawText: string,
  options: PreviewConversationImportTextOptions = {},
): Promise<BrowserConversationImportPreview> {
  const conversations = parseConversationImportText(source, rawText, options);
  const batchId = options.batchId ?? "preview";
  const { report } = await collectImport(asAsync(conversations), {
    source,
    batchId,
    dryRun: true,
    total: conversations.length,
  });
  let redactions = 0;
  const examples: BrowserConversationImportExample[] = [];
  for (const conversation of conversations) {
    if (conversation.title) redactions += countRedactions(conversation.title);
    for (const message of conversation.messages) {
      redactions += countRedactions(message.text);
      if (examples.length < 3) {
        examples.push({
          title: redactText(conversation.title ?? "Untitled conversation"),
          role: message.role,
          text: redactText(message.text),
          createdAt: message.createdAt,
        });
      }
    }
  }
  const warnings: string[] = [];
  if (
    (source === "hermes" || source === "openclaw") &&
    conversations.length > 0
  ) {
    warnings.push(
      `${source} browser import handles the selected file only; full home-directory imports use the canonical Node parser.`,
    );
  }
  return {
    source,
    counts: {
      conversations: report.summary.total,
      messages: conversations.reduce(
        (total, conversation) => total + conversation.messages.length,
        0,
      ),
      documents: report.summary.documentsStored,
      redactions,
    },
    examples,
    warnings,
  };
}

export async function runConversationImportText(
  options: RunConversationImportTextOptions,
): Promise<RunImportResult> {
  const conversations = parseConversationImportText(
    options.source,
    options.rawText,
    options,
  );
  const gen = runImport(asAsync(conversations), {
    source: options.source,
    batchId: options.batchId,
    sink: options.sink,
    entityId: options.entityId,
    total: conversations.length,
  });
  let result = await gen.next();
  while (!result.done) {
    options.onProgress?.({
      done: result.value.processed,
      total: result.value.total ?? conversations.length,
    });
    result = await gen.next();
  }
  return result.value;
}
