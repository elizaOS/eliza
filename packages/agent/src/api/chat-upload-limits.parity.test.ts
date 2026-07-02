/**
 * Client ↔ server chat-upload cap parity.
 *
 * The message-destruction bug this guards against: the client accepted files
 * the server's validateChatImages rejects (bigger caps, wildcard image types),
 * so a send 400'd AFTER the composer was cleared and the optimistic bubble was
 * wiped — text + attachments irrecoverably lost. Both sides now import
 * @elizaos/shared/chat-upload-limits; these tests pin the EFFECTIVE caps of
 * each side to those shared constants so any re-hardcoded copy (on either
 * side) turns into a red test instead of destroyed user messages.
 */
import {
  MAX_CHAT_ATTACHMENT_NAME_LENGTH,
  MAX_CHAT_IMAGE_BASE64_BYTES,
  MAX_CHAT_MEDIA_BASE64_BYTES,
  MAX_CHAT_MEDIA_RAW_BYTES,
  MAX_CHAT_UPLOAD_ATTACHMENTS,
  CHAT_UPLOAD_MIME_TYPES as SHARED_CHAT_UPLOAD_MIME_TYPES,
} from "@elizaos/shared/chat-upload-limits";
import {
  MAX_CHAT_IMAGES as CLIENT_MAX_CHAT_IMAGES,
  isSupportedChatUpload,
  perFileByteCap,
} from "@elizaos/ui/utils/image-attachment";
import { describe, expect, it } from "vitest";
import {
  CHAT_UPLOAD_MIME_TYPES,
  validateChatImages,
} from "./server-helpers.ts";

const attachment = (overrides: Partial<Record<string, unknown>> = {}) => ({
  data: "AAAA",
  mimeType: "image/png",
  name: "f.png",
  ...overrides,
});

describe("chat-upload caps: server enforces exactly the shared constants", () => {
  it("accepts an image at the shared base64 cap and rejects one group over", () => {
    expect(
      validateChatImages([
        attachment({ data: "A".repeat(MAX_CHAT_IMAGE_BASE64_BYTES) }),
      ]),
    ).toBeNull();
    expect(
      validateChatImages([
        attachment({ data: "A".repeat(MAX_CHAT_IMAGE_BASE64_BYTES + 4) }),
      ]),
    ).toMatch(/too large/);
  });

  it("accepts non-image media at the shared media cap and rejects over it", () => {
    expect(
      validateChatImages([
        attachment({
          data: "A".repeat(MAX_CHAT_MEDIA_BASE64_BYTES),
          mimeType: "audio/mpeg",
          name: "f.mp3",
        }),
      ]),
    ).toBeNull();
    expect(
      validateChatImages([
        attachment({
          data: "A".repeat(MAX_CHAT_MEDIA_BASE64_BYTES + 4),
          mimeType: "audio/mpeg",
          name: "f.mp3",
        }),
      ]),
    ).toMatch(/too large/);
  });

  it("accepts exactly the shared attachment count and rejects one more", () => {
    expect(
      validateChatImages(
        Array.from({ length: MAX_CHAT_UPLOAD_ATTACHMENTS }, () => attachment()),
      ),
    ).toBeNull();
    expect(
      validateChatImages(
        Array.from({ length: MAX_CHAT_UPLOAD_ATTACHMENTS + 1 }, () =>
          attachment(),
        ),
      ),
    ).toMatch(/Too many attachments/);
  });

  it("accepts names at the shared length cap and rejects longer", () => {
    expect(
      validateChatImages([
        attachment({ name: "n".repeat(MAX_CHAT_ATTACHMENT_NAME_LENGTH) }),
      ]),
    ).toBeNull();
    expect(
      validateChatImages([
        attachment({ name: "n".repeat(MAX_CHAT_ATTACHMENT_NAME_LENGTH + 1) }),
      ]),
    ).toMatch(/name too long/);
  });

  it("accepts every shared MIME type and rejects an off-list one", () => {
    for (const mimeType of SHARED_CHAT_UPLOAD_MIME_TYPES) {
      expect(validateChatImages([attachment({ mimeType })])).toBeNull();
    }
    expect(
      validateChatImages([attachment({ mimeType: "image/heic" })]),
    ).toMatch(/Unsupported attachment type/);
  });

  it("re-exports the shared allowlist verbatim (no local fork)", () => {
    expect(CHAT_UPLOAD_MIME_TYPES).toBe(SHARED_CHAT_UPLOAD_MIME_TYPES);
  });
});

describe("chat-upload caps: client effective caps equal the shared constants", () => {
  it("client count cap === shared count cap (server-enforced)", () => {
    expect(CLIENT_MAX_CHAT_IMAGES).toBe(MAX_CHAT_UPLOAD_ATTACHMENTS);
  });

  it("client per-file cap for non-image media base64-fits the server cap", () => {
    const video = { type: "video/mp4", name: "clip.mp4" } as File;
    const cap = perFileByteCap(video);
    expect(cap).toBe(MAX_CHAT_MEDIA_RAW_BYTES);
    // A file at the client cap encodes under the server's base64 cap — the
    // exact invariant whose violation destroyed messages.
    expect(Math.ceil(cap / 3) * 4).toBeLessThanOrEqual(
      MAX_CHAT_MEDIA_BASE64_BYTES,
    );
  });

  it("client accepts every MIME type the server accepts", () => {
    for (const mimeType of SHARED_CHAT_UPLOAD_MIME_TYPES) {
      expect(isSupportedChatUpload({ type: mimeType } as File)).toBe(true);
    }
  });

  it("client no longer forwards non-image media the server would 400", () => {
    // Wildcard audio/video acceptance was part of the drift: audio/x-m4a
    // passed the client and 400'd server-side.
    expect(isSupportedChatUpload({ type: "audio/x-m4a" } as File)).toBe(false);
    expect(isSupportedChatUpload({ type: "video/x-msvideo" } as File)).toBe(
      false,
    );
    // Any image/* stays accepted client-side: the canvas re-encode converts it
    // to an allowlisted JPEG before send.
    expect(isSupportedChatUpload({ type: "image/heic" } as File)).toBe(true);
  });
});
