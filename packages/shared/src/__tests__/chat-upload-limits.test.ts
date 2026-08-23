import { describe, expect, it } from "vitest";
import {
  CHAT_IMAGE_MIME_TYPE_SET,
  CHAT_IMAGE_MIME_TYPES,
  CHAT_UPLOAD_MIME_TYPE_SET,
  CHAT_UPLOAD_MIME_TYPES,
  MAX_CHAT_ATTACHMENT_NAME_LENGTH,
  MAX_CHAT_IMAGE_BASE64_BYTES,
  MAX_CHAT_IMAGE_RAW_BYTES,
  MAX_CHAT_MEDIA_RAW_BYTES,
  MAX_CHAT_UPLOAD_ATTACHMENTS,
  maxRawBytesForBase64,
} from "./chat-upload-limits.ts";

describe("maxRawBytesForBase64", () => {
  it("converts base64 caps to raw byte limits", () => {
    expect(maxRawBytesForBase64(12)).toBe(9);
    expect(maxRawBytesForBase64(1_048_576)).toBe(786_432);
  });

  it("guarantees base64 length stays under the cap", () => {
    const raw = maxRawBytesForBase64(MAX_CHAT_IMAGE_BASE64_BYTES);
    const base64Len = Buffer.alloc(raw).toString("base64").length;
    expect(base64Len).toBeLessThanOrEqual(MAX_CHAT_IMAGE_BASE64_BYTES);
  });
});

describe("upload limits", () => {
  it("keeps image raw under the base64 cap", () => {
    expect(MAX_CHAT_IMAGE_RAW_BYTES).toBeLessThan(MAX_CHAT_IMAGE_BASE64_BYTES);
    expect(MAX_CHAT_MEDIA_RAW_BYTES).toBeLessThan(15 * 1_048_576);
  });

  it("caps attachments and name length", () => {
    expect(MAX_CHAT_UPLOAD_ATTACHMENTS).toBe(4);
    expect(MAX_CHAT_ATTACHMENT_NAME_LENGTH).toBe(255);
  });

  it("image types are a subset of all upload types", () => {
    for (const t of CHAT_IMAGE_MIME_TYPES) {
      expect(CHAT_UPLOAD_MIME_TYPE_SET.has(t)).toBe(true);
    }
    expect(CHAT_UPLOAD_MIME_TYPES.length).toBeGreaterThan(
      CHAT_IMAGE_MIME_TYPES.length,
    );
  });

  it("mime sets expose O(1) membership", () => {
    expect(CHAT_IMAGE_MIME_TYPE_SET.has("image/jpeg")).toBe(true);
    expect(CHAT_IMAGE_MIME_TYPE_SET.has("image/heic")).toBe(false);
    expect(CHAT_UPLOAD_MIME_TYPE_SET.has("application/pdf")).toBe(true);
  });
});
