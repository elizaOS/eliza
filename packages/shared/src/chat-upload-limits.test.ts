/**
 * Exercises the chat-upload size and MIME contracts: maxRawBytesForBase64
 * derives a raw-byte cap whose base64 encoding stays under each base64 ceiling
 * (checked against Node's real base64 encoder), and the image/upload MIME
 * allowlists stay lowercase, mutually consistent, and free of the phone-photo
 * formats (HEIC/HEIF/SVG) the client must re-encode before upload.
 */
import { describe, expect, it } from "vitest";
import {
  CHAT_IMAGE_MIME_TYPE_SET,
  CHAT_IMAGE_MIME_TYPES,
  CHAT_UPLOAD_MIME_TYPE_SET,
  CHAT_UPLOAD_MIME_TYPES,
  MAX_CHAT_IMAGE_BASE64_BYTES,
  MAX_CHAT_IMAGE_RAW_BYTES,
  MAX_CHAT_MEDIA_BASE64_BYTES,
  MAX_CHAT_MEDIA_RAW_BYTES,
  maxRawBytesForBase64,
} from "./chat-upload-limits.ts";

/** Exact base64 length for `n` raw bytes (4 chars per padded 3-byte group). */
const base64LengthFor = (rawBytes: number): number =>
  Math.ceil(rawBytes / 3) * 4;

describe("maxRawBytesForBase64", () => {
  it("derives a raw cap whose base64 encoding fits under the base64 cap", () => {
    for (const cap of [
      MAX_CHAT_IMAGE_BASE64_BYTES,
      MAX_CHAT_MEDIA_BASE64_BYTES,
    ]) {
      const raw = maxRawBytesForBase64(cap);
      expect(base64LengthFor(raw)).toBeLessThanOrEqual(cap);
      // The derived cap is tight: adding one more 3-byte base64 group overflows.
      expect(base64LengthFor(raw + 3)).toBeGreaterThan(cap);
    }
  });

  it("round-trips on a real buffer at the derived raw cap", () => {
    // Small-scale check with real base64 so the arithmetic model can't drift
    // from the actual encoder: 100 chars of base64 budget → 75 raw bytes.
    const cap = 100;
    const raw = maxRawBytesForBase64(cap);
    const encoded = Buffer.alloc(raw).toString("base64");
    expect(encoded.length).toBeLessThanOrEqual(cap);
    expect(Buffer.alloc(raw + 3).toString("base64").length).toBeGreaterThan(
      cap,
    );
  });

  it("exports derived raw caps consistent with the base64 caps", () => {
    expect(MAX_CHAT_IMAGE_RAW_BYTES).toBe(
      maxRawBytesForBase64(MAX_CHAT_IMAGE_BASE64_BYTES),
    );
    expect(MAX_CHAT_MEDIA_RAW_BYTES).toBe(
      maxRawBytesForBase64(MAX_CHAT_MEDIA_BASE64_BYTES),
    );
    // Images have the tighter cap — the client's downscale pass targets it.
    expect(MAX_CHAT_IMAGE_BASE64_BYTES).toBeLessThan(
      MAX_CHAT_MEDIA_BASE64_BYTES,
    );
  });
});

describe("MIME allowlists", () => {
  it("every image subtype is also an accepted upload type", () => {
    for (const mime of CHAT_IMAGE_MIME_TYPES) {
      expect(CHAT_UPLOAD_MIME_TYPE_SET.has(mime)).toBe(true);
    }
  });

  it("set views match the canonical arrays exactly", () => {
    expect([...CHAT_IMAGE_MIME_TYPE_SET].sort()).toEqual(
      [...CHAT_IMAGE_MIME_TYPES].sort(),
    );
    expect([...CHAT_UPLOAD_MIME_TYPE_SET].sort()).toEqual(
      [...CHAT_UPLOAD_MIME_TYPES].sort(),
    );
  });

  it("is lowercase (membership checks lowercase the candidate)", () => {
    for (const mime of CHAT_UPLOAD_MIME_TYPES) {
      expect(mime).toBe(mime.toLowerCase());
    }
  });

  it("excludes the phone-photo formats the client must re-encode", () => {
    // HEIC/HEIF is what iPhones shoot by default — the whole reason the client
    // re-encode pass exists. It must NOT silently join the server allowlist
    // without the client conversion story being revisited.
    expect(CHAT_IMAGE_MIME_TYPE_SET.has("image/heic")).toBe(false);
    expect(CHAT_IMAGE_MIME_TYPE_SET.has("image/heif")).toBe(false);
    expect(CHAT_IMAGE_MIME_TYPE_SET.has("image/svg+xml")).toBe(false);
  });
});
