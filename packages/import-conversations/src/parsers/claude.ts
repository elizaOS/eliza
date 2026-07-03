import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";

import type { ConversationImporter } from "../core/registry.ts";
import type {
  AttachmentKind,
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

export type ParseOptions = {
  /**
   * Keep file/image attachment metadata and inline `extracted_content` blocks.
   * On by default because Claude exports include useful text extracted from
   * uploaded documents.
   */
  includeAttachments?: boolean;
};

const SOURCE = "claude" as const;
const CONVERSATIONS_JSON = "conversations.json";

const DEFAULT_OPTIONS: Required<ParseOptions> = {
  includeAttachments: true,
};

type RecordLike = Record<string, unknown>;

function isRecord(value: unknown): value is RecordLike {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(
  record: RecordLike,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}

function arrayField(record: RecordLike, keys: readonly string[]): unknown[] {
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function toEpochMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

function normalizeRole(sender: string | undefined): NormalizedRole | undefined {
  if (sender === "human" || sender === "user") return "user";
  if (sender === "assistant") return "assistant";
  if (sender === "system") return "system";
  if (sender === "tool") return "tool";
  return undefined;
}

function maybeFenceCode(text: string, language: string | undefined): string {
  const lang = language ? language.replace(/[^a-z0-9_+-]/gi, "") : "";
  return `\`\`\`${lang}\n${text}\n\`\`\``;
}

function textFromContentBlock(block: unknown): string | undefined {
  if (typeof block === "string") return block;
  if (!isRecord(block)) return undefined;

  const type = stringField(block, ["type"]);
  if (type === "image" || type === "file" || type === "attachment") {
    return undefined;
  }

  const text = stringField(block, [
    "text",
    "content",
    "value",
    "input",
    "name",
  ]);
  if (!text) return undefined;

  if (type === "code") {
    return maybeFenceCode(text, stringField(block, ["language", "lang"]));
  }
  return text;
}

function textFromMessage(record: RecordLike): string {
  const directText = stringField(record, ["text"]);
  if (directText !== undefined) return directText;

  const content = record.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";

  return content
    .map(textFromContentBlock)
    .filter((part): part is string => Boolean(part && part.trim().length > 0))
    .join("\n\n");
}

function attachmentKind(record: RecordLike): AttachmentKind {
  const type = stringField(record, ["type", "kind"]);
  const mime = stringField(record, ["mime_type", "mimeType", "content_type"]);
  if (type === "image" || mime?.startsWith("image/")) return "image";
  if (type === "code") return "code";
  if (stringField(record, ["extracted_content", "extractedContent"])) {
    return "extracted-text";
  }
  return "file";
}

function attachmentFromRecord(
  record: RecordLike,
): NormalizedAttachment | undefined {
  const extracted = stringField(record, [
    "extracted_content",
    "extractedContent",
    "extracted_text",
    "extractedText",
  ]);
  const code = stringField(record, ["code"]);
  const name =
    stringField(record, [
      "file_name",
      "filename",
      "name",
      "title",
      "id",
      "type",
    ]) ?? "attachment";

  const kind = attachmentKind(record);
  const text =
    extracted ??
    (kind === "code" && code ? maybeFenceCode(code, undefined) : undefined);

  if (!text && name === "attachment" && kind === "file") return undefined;

  return { name, kind, text };
}

function attachmentsFromMessage(record: RecordLike): NormalizedAttachment[] {
  const out: NormalizedAttachment[] = [];
  for (const candidate of [
    ...arrayField(record, ["attachments", "files"]),
    ...arrayField(record, ["content"]),
  ]) {
    if (!isRecord(candidate)) continue;
    const attachment = attachmentFromRecord(candidate);
    if (attachment) out.push(attachment);
  }

  const seen = new Set<string>();
  return out.filter((attachment) => {
    const key = `${attachment.kind}\0${attachment.name}\0${attachment.text ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeMessage(
  value: unknown,
  opts: Required<ParseOptions>,
): NormalizedMessage | undefined {
  if (!isRecord(value)) return undefined;

  const role = normalizeRole(stringField(value, ["sender", "role"]));
  if (!role) return undefined;

  const attachments = opts.includeAttachments
    ? attachmentsFromMessage(value)
    : [];
  const text = textFromMessage(value);
  if (text.trim().length === 0 && attachments.length === 0) return undefined;

  const message: NormalizedMessage = {
    sourceMessageId: stringField(value, [
      "uuid",
      "id",
      "message_id",
      "messageId",
    ]),
    role,
    text,
    createdAt: toEpochMs(
      stringField(value, ["created_at", "createdAt", "timestamp"]),
    ),
    attachments: attachments.length > 0 ? attachments : undefined,
  };

  return message;
}

function conversationTimestamps(messages: NormalizedMessage[]): {
  createdAt?: number;
  updatedAt?: number;
} {
  let createdAt: number | undefined;
  let updatedAt: number | undefined;
  for (const message of messages) {
    if (typeof message.createdAt !== "number") continue;
    if (createdAt === undefined || message.createdAt < createdAt) {
      createdAt = message.createdAt;
    }
    if (updatedAt === undefined || message.createdAt > updatedAt) {
      updatedAt = message.createdAt;
    }
  }
  return { createdAt, updatedAt };
}

function normalizeConversation(
  value: unknown,
  index: number,
  opts: Required<ParseOptions>,
): NormalizedConversation | undefined {
  if (!isRecord(value)) return undefined;

  const rawMessages = arrayField(value, ["chat_messages", "messages"]);
  if (rawMessages.length === 0) return undefined;

  const messages = rawMessages
    .map((message) => normalizeMessage(message, opts))
    .filter((message): message is NormalizedMessage => Boolean(message));
  if (messages.length === 0) return undefined;

  const { createdAt: firstMessageAt, updatedAt: lastMessageAt } =
    conversationTimestamps(messages);
  const sourceConversationId =
    stringField(value, ["uuid", "id", "conversation_id", "conversationId"]) ??
    `claude-conversation-${index + 1}`;
  const title =
    stringField(value, ["name", "title"]) ??
    `Claude conversation ${sourceConversationId}`;

  return {
    sourceConversationId,
    title,
    createdAt:
      toEpochMs(stringField(value, ["created_at", "createdAt"])) ??
      firstMessageAt,
    updatedAt:
      toEpochMs(stringField(value, ["updated_at", "updatedAt"])) ??
      lastMessageAt ??
      firstMessageAt,
    messages,
    meta: {
      model: stringField(value, ["model", "model_name", "modelName"]),
      project: stringField(value, ["project", "project_name", "projectName"]),
      tags: ["claude-export"],
    },
  };
}

function looksLikeClaudeConversation(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value.chat_messages);
}

async function resolveInput(
  input: string,
): Promise<
  { kind: "json"; path: string } | { kind: "zip"; path: string } | undefined
> {
  let st: Awaited<ReturnType<typeof stat>>;
  try {
    st = await stat(input);
  } catch {
    return undefined;
  }

  if (st.isDirectory()) {
    const jsonPath = path.join(input, CONVERSATIONS_JSON);
    return existsSync(jsonPath) ? { kind: "json", path: jsonPath } : undefined;
  }

  if (!st.isFile()) return undefined;
  if (input.toLowerCase().endsWith(".zip")) {
    return { kind: "zip", path: input };
  }
  if (path.basename(input).toLowerCase() === CONVERSATIONS_JSON) {
    return { kind: "json", path: input };
  }
  return undefined;
}

async function openConversationsStream(input: string): Promise<Readable> {
  const resolved = await resolveInput(input);
  if (!resolved) {
    throw new Error(
      `Claude export input must be a directory, ${CONVERSATIONS_JSON}, or .zip`,
    );
  }

  if (resolved.kind === "json") {
    return createReadStream(resolved.path);
  }

  return openZipEntryStream(resolved.path, CONVERSATIONS_JSON);
}

async function detect(input: string): Promise<boolean> {
  try {
    const resolved = await resolveInput(input);
    if (!resolved) return false;
    if (resolved.kind === "zip") {
      const metadata = await findZipEntryMetadata(
        resolved.path,
        CONVERSATIONS_JSON,
      );
      if (!metadata) return false;
    }

    const first = await readFirstJsonArrayObject(
      await openConversationsStream(input),
    );
    return looksLikeClaudeConversation(first);
  } catch {
    return false;
  }
}

async function* parse(
  input: string,
  options?: ParseOptions,
): AsyncIterable<NormalizedConversation> {
  const opts: Required<ParseOptions> = { ...DEFAULT_OPTIONS, ...options };
  const source = await openConversationsStream(input);
  let index = 0;

  for await (const value of streamJsonArrayObjects(source)) {
    const conversation = normalizeConversation(value, index, opts);
    index += 1;
    if (conversation) yield conversation;
  }
}

export const claudeParser: ConversationImporter<string> = {
  source: SOURCE,
  detect,
  parse,
};

export { detect, parse };
export default claudeParser;
