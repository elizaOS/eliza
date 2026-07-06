/**
 * Deterministic unit tests for chat-attachment plumbing: `serializeMessageAttachments`
 * (which URLs survive into a serialized message and which unpersisted placeholders
 * are dropped) and `validateChatImages` (accepted MIME types, the raw-base64
 * requirement, and the count and per-item size caps).
 */
import { describe, expect, it } from "vitest";
import { serializeMessageAttachments } from "./conversation-routes.ts";
import { validateChatImages } from "./server-helpers.ts";

describe("serializeMessageAttachments", () => {
  it("returns undefined when there are no attachments", () => {
    expect(serializeMessageAttachments(undefined)).toBeUndefined();
    expect(serializeMessageAttachments({})).toBeUndefined();
    expect(serializeMessageAttachments({ attachments: [] })).toBeUndefined();
  });

  it("keeps renderable URLs and copies the canonical fields", () => {
    const out = serializeMessageAttachments({
      attachments: [
        {
          id: "a1",
          url: "https://cdn.example.com/cat.png",
          contentType: "image",
          title: "cat.png",
          description: "a cat",
          source: "client_chat",
          text: "OCR text",
          mimeType: "image/png",
        },
      ],
    });
    expect(out).toEqual([
      {
        id: "a1",
        url: "https://cdn.example.com/cat.png",
        contentType: "image",
        title: "cat.png",
        description: "a cat",
        source: "client_chat",
        text: "OCR text",
        mimeType: "image/png",
      },
    ]);
  });

  it("keeps served, data, and blob URLs", () => {
    const out = serializeMessageAttachments({
      attachments: [
        { id: "s", url: "/api/media/abc.png" },
        { id: "d", url: "data:image/png;base64,AAAA" },
        { id: "b", url: "blob:nonsense" },
      ],
    });
    expect(out?.map((a) => a.id)).toEqual(["s", "d", "b"]);
  });

  it("round-trips the notProcessed enrichment reason", () => {
    const out = serializeMessageAttachments({
      attachments: [
        {
          id: "aud",
          url: "/api/media/abc.mp3",
          contentType: "audio",
          notProcessed: "Audio transcription unavailable: no provider",
        },
      ],
    });
    expect(out?.[0].notProcessed).toBe(
      "Audio transcription unavailable: no provider",
    );
  });

  it("omits notProcessed when the attachment was enriched cleanly", () => {
    const out = serializeMessageAttachments({
      attachments: [{ id: "img", url: "/api/media/abc.png", text: "OCR" }],
    });
    expect(out?.[0]).not.toHaveProperty("notProcessed");
  });

  it("drops non-renderable placeholder URLs (unpersisted uploads)", () => {
    expect(
      serializeMessageAttachments({
        attachments: [{ id: "x", url: "attachment:img-0" }],
      }),
    ).toBeUndefined();
  });

  it("skips malformed entries", () => {
    const out = serializeMessageAttachments({
      attachments: [null, 42, { url: "" }, { url: "/api/media/ok.png" }],
    });
    expect(out).toHaveLength(1);
    expect(out?.[0].url).toBe("/api/media/ok.png");
  });
});

describe("validateChatImages", () => {
  const ok = (mimeType: string) => [{ data: "AAAA", mimeType, name: "f" }];

  it("accepts an empty / missing list", () => {
    expect(validateChatImages(undefined)).toBeNull();
    expect(validateChatImages([])).toBeNull();
  });

  it("accepts images, audio, video, pdf, text, and json", () => {
    expect(validateChatImages(ok("image/png"))).toBeNull();
    expect(validateChatImages(ok("audio/mpeg"))).toBeNull();
    expect(validateChatImages(ok("audio/wav"))).toBeNull();
    expect(validateChatImages(ok("audio/mp4"))).toBeNull();
    expect(validateChatImages(ok("video/mp4"))).toBeNull();
    expect(validateChatImages(ok("video/webm"))).toBeNull();
    expect(validateChatImages(ok("application/pdf"))).toBeNull();
    expect(validateChatImages(ok("text/plain"))).toBeNull();
    expect(validateChatImages(ok("text/csv"))).toBeNull();
    expect(validateChatImages(ok("text/markdown"))).toBeNull();
    expect(validateChatImages(ok("application/json"))).toBeNull();
  });

  it("rejects unsupported types", () => {
    expect(validateChatImages(ok("application/x-msdownload"))).toMatch(
      /Unsupported attachment type/,
    );
    // A spoofed SVG-as-image (image/svg+xml is deliberately NOT on the upload
    // allow-list — it can carry script) is rejected before the store ever sees
    // it; the media store's markup sniffer is the second line of defence.
    expect(validateChatImages(ok("image/svg+xml"))).toMatch(
      /Unsupported attachment type/,
    );
  });

  it("rejects corrupt base64 that decodes to zero bytes", () => {
    // Degenerate-but-syntactically-valid base64 (`=`, `==`, a lone char) is a
    // non-empty string that carries no bytes; persisting it would write an empty
    // file into the store and land an unreadable attachment.
    for (const data of ["=", "==", "A"]) {
      expect(
        validateChatImages([{ data, mimeType: "image/png", name: "f" }]),
        data,
      ).toMatch(/zero bytes/);
    }
    // A well-formed 1+ byte payload is still accepted.
    expect(
      validateChatImages([{ data: "QQ==", mimeType: "image/png", name: "f" }]),
    ).toBeNull();
  });

  it("rejects base64 with invalid characters", () => {
    expect(
      validateChatImages([
        { data: "not valid base64!!", mimeType: "image/png", name: "f" },
      ]),
    ).toMatch(/invalid base64/);
  });

  it("enforces the larger media cap for non-image attachments", () => {
    // A ~12 MiB base64 audio payload is under the 15 MiB media cap but over the
    // 5 MiB image cap — it must be accepted (media cap), proving the two caps
    // are applied per-kind, not uniformly.
    const mediaSized = "A".repeat(12 * 1_048_576);
    expect(
      validateChatImages([
        { data: mediaSized, mimeType: "audio/mpeg", name: "clip.mp3" },
      ]),
    ).toBeNull();
    // The same payload as an IMAGE exceeds the 5 MiB image cap → rejected.
    expect(
      validateChatImages([
        { data: mediaSized, mimeType: "image/png", name: "big.png" },
      ]),
    ).toMatch(/too large/);
  });

  it("rejects data-URL payloads (must be raw base64)", () => {
    expect(
      validateChatImages([
        {
          data: "data:image/png;base64,AAAA",
          mimeType: "image/png",
          name: "f",
        },
      ]),
    ).toMatch(/raw base64/);
  });

  it("rejects too many attachments", () => {
    expect(
      validateChatImages(
        Array.from({ length: 5 }, () => ({
          data: "AAAA",
          mimeType: "image/png",
          name: "f",
        })),
      ),
    ).toMatch(/Too many attachments/);
  });

  it("enforces the per-image size cap", () => {
    const big = "A".repeat(6 * 1_048_576);
    expect(
      validateChatImages([{ data: big, mimeType: "image/png", name: "f" }]),
    ).toMatch(/too large/);
  });
});
