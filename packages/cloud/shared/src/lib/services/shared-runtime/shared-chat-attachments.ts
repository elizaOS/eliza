/**
 * Validates cloud chat-upload payloads and projects them into ephemeral core
 * media records. Raw bytes remain request-scoped: callers may forward them to
 * AgentRuntime, but must never persist the private inline fields in history.
 */

import { ContentType, MESSAGE_SOURCE_CLIENT_CHAT, type Media } from "@elizaos/core/edge";
import {
  CHAT_UPLOAD_MIME_TYPE_SET,
  MAX_CHAT_ATTACHMENT_NAME_LENGTH,
  MAX_CHAT_IMAGE_BASE64_BYTES,
  MAX_CHAT_MEDIA_BASE64_BYTES,
  MAX_CHAT_UPLOAD_ATTACHMENTS,
} from "@elizaos/shared";

const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;

export interface SharedChatAttachment {
  data: string;
  mimeType: string;
  name: string;
  thumbnail?: {
    data: string;
    mimeType: string;
  };
}

export type SharedInlineMedia = Media & {
  _data: string;
  _mimeType: string;
};

export type SharedChatAttachmentParseResult =
  | { ok: true; attachments: SharedChatAttachment[] }
  | { ok: false; error: string };

function decodedBase64Bytes(data: string): number {
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.floor((data.length * 3) / 4) - padding;
}

function validateBase64(data: unknown, label: string, maxBytes: number): string | null {
  if (typeof data !== "string" || !data) {
    return `${label} must be a non-empty data string`;
  }
  if (data.startsWith("data:")) {
    return `${label} data must be raw base64, not a data URL`;
  }
  if (data.length > maxBytes) {
    return `${label} too large (max ${maxBytes / 1_048_576} MB)`;
  }
  if (!BASE64_RE.test(data)) {
    return `${label} data contains invalid base64 characters`;
  }
  if (decodedBase64Bytes(data) <= 0) {
    return `${label} data decodes to zero bytes`;
  }
  return null;
}

/** Parse an untrusted `images` field under the canonical chat-upload policy. */
export function parseSharedChatAttachments(value: unknown): SharedChatAttachmentParseResult {
  if (value === undefined || value === null) return { ok: true, attachments: [] };
  if (!Array.isArray(value)) return { ok: false, error: "images must be an array" };
  if (value.length === 0) return { ok: true, attachments: [] };
  if (value.length > MAX_CHAT_UPLOAD_ATTACHMENTS) {
    return {
      ok: false,
      error: `Too many attachments (max ${MAX_CHAT_UPLOAD_ATTACHMENTS})`,
    };
  }

  const attachments: SharedChatAttachment[] = [];
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      return { ok: false, error: "Each attachment must be an object" };
    }
    const record = candidate as Record<string, unknown>;
    const mimeType = typeof record.mimeType === "string" ? record.mimeType.toLowerCase() : "";
    if (!mimeType) {
      return { ok: false, error: "Each attachment must have a mimeType string" };
    }
    if (!CHAT_UPLOAD_MIME_TYPE_SET.has(mimeType)) {
      return { ok: false, error: `Unsupported attachment type: ${record.mimeType}` };
    }
    const maxBytes = mimeType.startsWith("image/")
      ? MAX_CHAT_IMAGE_BASE64_BYTES
      : MAX_CHAT_MEDIA_BASE64_BYTES;
    const dataError = validateBase64(record.data, "Attachment", maxBytes);
    if (dataError) return { ok: false, error: dataError };
    if (typeof record.name !== "string" || !record.name) {
      return { ok: false, error: "Each attachment must have a name string" };
    }
    if (record.name.length > MAX_CHAT_ATTACHMENT_NAME_LENGTH) {
      return {
        ok: false,
        error: `Attachment name too long (max ${MAX_CHAT_ATTACHMENT_NAME_LENGTH} characters)`,
      };
    }

    let thumbnail: SharedChatAttachment["thumbnail"];
    if (record.thumbnail !== undefined) {
      if (
        !record.thumbnail ||
        typeof record.thumbnail !== "object" ||
        Array.isArray(record.thumbnail)
      ) {
        return { ok: false, error: "Attachment thumbnail must be an object" };
      }
      const thumbnailRecord = record.thumbnail as Record<string, unknown>;
      const thumbnailError = validateBase64(
        thumbnailRecord.data,
        "Thumbnail",
        MAX_CHAT_IMAGE_BASE64_BYTES,
      );
      if (thumbnailError) return { ok: false, error: thumbnailError };
      if (
        typeof thumbnailRecord.mimeType !== "string" ||
        !thumbnailRecord.mimeType.toLowerCase().startsWith("image/")
      ) {
        return { ok: false, error: "Thumbnail mimeType must be an image type" };
      }
      thumbnail = {
        data: thumbnailRecord.data as string,
        mimeType: thumbnailRecord.mimeType.toLowerCase(),
      };
    }

    attachments.push({
      data: record.data as string,
      mimeType,
      name: record.name,
      ...(thumbnail ? { thumbnail } : {}),
    });
  }
  return { ok: true, attachments };
}

function contentTypeForMime(mimeType: string): ContentType {
  if (mimeType.startsWith("image/")) return ContentType.IMAGE;
  if (mimeType.startsWith("audio/")) return ContentType.AUDIO;
  if (mimeType.startsWith("video/")) return ContentType.VIDEO;
  return ContentType.DOCUMENT;
}

/** Build request-scoped media records understood by core attachment enrichment. */
export function toSharedInlineMedia(
  attachments: readonly SharedChatAttachment[],
): SharedInlineMedia[] {
  return attachments.map((attachment, index) => ({
    id: `shared-upload-${index}`,
    url: `attachment:inline-${index}`,
    title: attachment.name,
    filename: attachment.name,
    source: MESSAGE_SOURCE_CLIENT_CHAT,
    contentType: contentTypeForMime(attachment.mimeType),
    mimeType: attachment.mimeType,
    size: decodedBase64Bytes(attachment.data),
    _data: attachment.data,
    _mimeType: attachment.mimeType,
  }));
}
