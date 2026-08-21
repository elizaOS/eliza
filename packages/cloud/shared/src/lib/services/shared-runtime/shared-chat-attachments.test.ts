/**
 * Validates the shared-runtime attachment boundary with deterministic inline payloads.
 */

import { describe, expect, test } from "bun:test";
import { ContentType } from "@elizaos/core/edge";
import { parseSharedChatAttachments, toSharedInlineMedia } from "./shared-chat-attachments";

const png = Buffer.from("tiny png").toString("base64");

describe("shared chat attachments", () => {
  test("normalizes valid image and document payloads into runtime media", () => {
    const parsed = parseSharedChatAttachments([
      { name: "photo.png", mimeType: "IMAGE/PNG", data: png },
      { name: "notes.txt", mimeType: "text/plain", data: Buffer.from("hello").toString("base64") },
    ]);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error(parsed.error);
    expect(parsed.attachments[0]?.mimeType).toBe("image/png");
    expect(toSharedInlineMedia(parsed.attachments)).toMatchObject([
      { title: "photo.png", contentType: ContentType.IMAGE, _data: png, _mimeType: "image/png" },
      { title: "notes.txt", contentType: ContentType.DOCUMENT, _mimeType: "text/plain" },
    ]);
  });

  test("rejects malformed and excessive input before runtime dispatch", () => {
    expect(parseSharedChatAttachments({}).ok).toBe(false);
    expect(parseSharedChatAttachments([{ name: "x", mimeType: "image/png", data: "%%%" }]).ok).toBe(
      false,
    );
    expect(
      parseSharedChatAttachments(
        Array.from({ length: 5 }, (_, index) => ({
          name: `${index}.png`,
          mimeType: "image/png",
          data: png,
        })),
      ).ok,
    ).toBe(false);
    expect(
      parseSharedChatAttachments([
        { name: "x.exe", mimeType: "application/x-msdownload", data: png },
      ]).ok,
    ).toBe(false);
  });
});
