/**
 * Normalized conversation model — the contract every source parser maps into.
 *
 * Track A owns these types. Parsers (Tracks B/C/D: ChatGPT / Claude / Hermes)
 * are pure streaming functions that emit `NormalizedConversation`s; the
 * ingestion pipeline in this package consumes them source-agnostically.
 *
 * See conversation-importer-scope.md §3.4.
 */

/**
 * Known conversation sources. Open string union so future sources can register
 * without a type change (see {@link registerConversationImporter}).
 */
export type ConversationSource =
  | "chatgpt"
  | "claude"
  | "hermes"
  | "openclaw"
  | (string & {});

/**
 * Role of a single normalized message. `system` and `tool` are retained (some
 * parsers keep them behind flags) but rendering/ingestion treats user+assistant
 * as the primary signal.
 */
export type NormalizedRole = "user" | "assistant" | "system" | "tool";

/** Kind of an attachment carried alongside a message. */
export type AttachmentKind = "image" | "file" | "code" | "extracted-text";

/**
 * An attachment associated with a normalized message. `text` carries inlined
 * content (e.g. Claude's `extracted_content`, a fenced code block, or an
 * OCR/extracted-text blob) when available; binary media is represented by
 * `name` + `kind` only.
 */
export interface NormalizedAttachment {
  name: string;
  kind: AttachmentKind;
  /** Inlined textual content, when the export provides it. */
  text?: string;
}

/**
 * Per-message annotations that survive normalization but are not part of the
 * primary transcript text (branch/hidden markers, originating tool name).
 */
export interface MessageAnnotations {
  /** True when this message belongs to a non-active regeneration branch. */
  branch?: boolean;
  /** True when the source marked this message hidden from the conversation. */
  hidden?: boolean;
  /** Name of the tool that produced/consumed this message, if any. */
  toolName?: string;
}

/**
 * A single message after normalization. `text` is markdown-safe flattened text
 * (code fenced, images placeholdered) ready for transcript rendering.
 */
export interface NormalizedMessage {
  /** Stable id from the source export, when present. */
  sourceMessageId?: string;
  role: NormalizedRole;
  /** Markdown-safe flattened message text. May be empty (attachment-only). */
  text: string;
  /** Epoch milliseconds. */
  createdAt?: number;
  attachments?: NormalizedAttachment[];
  annotations?: MessageAnnotations;
}

/**
 * A single conversation after normalization. Ordered `messages` represent the
 * active thread (parsers are responsible for tree-flattening / branch pruning).
 */
export interface NormalizedConversation {
  /** Stable conversation id from the source export. */
  sourceConversationId: string;
  title?: string;
  /** Epoch milliseconds. */
  createdAt?: number;
  /** Epoch milliseconds. Drives idempotent re-import (see manifest). */
  updatedAt?: number;
  messages: NormalizedMessage[];
  meta?: {
    model?: string;
    project?: string;
    tags?: string[];
  };
}

/**
 * The top-level bundle a parser produces for a whole export. `conversations`
 * is intentionally an array on this eager shape; the streaming pipeline path
 * consumes an `AsyncIterable<NormalizedConversation>` directly and never
 * materializes a full bundle.
 */
export interface ConversationBundle {
  source: ConversationSource;
  /** Export format fingerprint (e.g. schema/version marker), when derivable. */
  sourceVersion?: string;
  account?: {
    id?: string;
    email?: string;
  };
  conversations: NormalizedConversation[];
}
