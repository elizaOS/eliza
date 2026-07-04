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

  it("accepts images, audio, video, and pdf", () => {
    expect(validateChatImages(ok("image/png"))).toBeNull();
    expect(validateChatImages(ok("audio/mpeg"))).toBeNull();
    expect(validateChatImages(ok("video/mp4"))).toBeNull();
    expect(validateChatImages(ok("application/pdf"))).toBeNull();
  });

  it("rejects unsupported types", () => {
    expect(validateChatImages(ok("application/x-msdownload"))).toMatch(
      /Unsupported attachment type/,
    );
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
