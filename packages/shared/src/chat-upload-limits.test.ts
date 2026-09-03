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
  MAX_CHAT_ATTACHMENT_NAME_LENGTH,
  MAX_CHAT_IMAGE_BASE64_BYTES,
  MAX_CHAT_IMAGE_RAW_BYTES,
  MAX_CHAT_MEDIA_BASE64_BYTES,
  MAX_CHAT_MEDIA_RAW_BYTES,
  MAX_CHAT_UPLOAD_ATTACHMENTS,
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

/**
 * The exclusion case above covers `CHAT_IMAGE_MIME_TYPES` only. The wider
 * upload allowlist has no equivalent, so `"text/html"` can be appended to it
 * with both this suite and the agent parity suite green — and every individual
 * entry in either list can be deleted just as quietly.
 */
describe("chat upload allowlist membership", () => {
  it.each(CHAT_IMAGE_MIME_TYPES)("keeps %s in the image allowlist", (mime) => {
    expect(CHAT_IMAGE_MIME_TYPE_SET.has(mime)).toBe(true);
    // The image list is spread into the upload list; a divergence here means a
    // type the client will send as an image is refused by the upload endpoint.
    expect(CHAT_UPLOAD_MIME_TYPE_SET.has(mime)).toBe(true);
  });

  it.each(CHAT_UPLOAD_MIME_TYPES)(
    "keeps %s in the upload allowlist",
    (mime) => {
      expect(CHAT_UPLOAD_MIME_TYPE_SET.has(mime)).toBe(true);
    },
  );

  it("names the exact contents of both lists", () => {
    // `it.each` over an empty array registers no cases at all, so the two
    // tables above cannot notice a list being emptied. These also make an
    // ADDITION a deliberate edit rather than a silent one.
    expect([...CHAT_IMAGE_MIME_TYPES]).toEqual([
      "image/jpeg",
      "image/png",
      "image/gif",
      "image/webp",
    ]);
    expect(CHAT_UPLOAD_MIME_TYPES).toHaveLength(23);
    expect(CHAT_UPLOAD_MIME_TYPE_SET.size).toBe(CHAT_UPLOAD_MIME_TYPES.length);
  });

  it.each([
    "text/html",
    "application/xhtml+xml",
    "image/svg+xml",
    "text/javascript",
    "application/javascript",
    "application/xml",
  ])(
    "keeps the active document type %s out of the upload allowlist",
    (mime) => {
      // Not because this list is the XSS boundary — it is not. `media-store.ts`
      // serves anything outside `isInlineSafeMime` with
      // `Content-Disposition: attachment`, `X-Content-Type-Options: nosniff` and a
      // sandbox CSP, and that holds today. But the two live in different packages
      // and neither knows about the other, so this list should not quietly start
      // accepting document types on the assumption that the other layer will
      // always catch them.
      expect(CHAT_UPLOAD_MIME_TYPE_SET.has(mime)).toBe(false);
    },
  );
});

describe("chat upload count and name bounds", () => {
  it("caps attachments per message at 4", () => {
    // A per-message fan-out bound: raising it multiplies both the request size
    // and the number of stored objects a single message can create.
    expect(MAX_CHAT_UPLOAD_ATTACHMENTS).toBe(4);
  });

  it("caps an attachment file name at 255 characters", () => {
    // 255 is the POSIX single-component limit, which is what makes a stored
    // name writable as a filename on the media volume.
    expect(MAX_CHAT_ATTACHMENT_NAME_LENGTH).toBe(255);
  });
});
