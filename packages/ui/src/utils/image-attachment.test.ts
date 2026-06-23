import { describe, expect, it } from "vitest";
import {
  buildDroppedAttachmentNotice,
  bytesToMb,
  CHAT_UPLOAD_ACCEPT,
  chatUploadKind,
  createImageThumbnail,
  isSupportedChatUpload,
  LARGE_PASTE_CHAR_THRESHOLD,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENTS_TOTAL_BYTES,
  MAX_CHAT_IMAGES,
  partitionAttachmentFiles,
  pastedTextToAttachment,
  resolveComposerPaste,
  shouldConvertPasteToAttachment,
  summarizeDroppedAttachments,
} from "./image-attachment";

/** Decode an attachment's UTF-8-safe base64 `data` back to the original text. */
const decodeAttachmentText = (data: string): string =>
  new TextDecoder().decode(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)));

const file = (type: string): File => ({ type }) as File;
const sizedFile = (type: string, size: number): File =>
  ({ type, size }) as File;
/** A named, sized File stand-in for partition tests. */
const namedFile = (name: string, size: number): File =>
  ({ name, size, type: "image/png" }) as File;

describe("chatUploadKind", () => {
  it("maps MIME types to attachment kinds", () => {
    expect(chatUploadKind("image/png")).toBe("image");
    expect(chatUploadKind("audio/mpeg")).toBe("audio");
    expect(chatUploadKind("video/mp4")).toBe("video");
    expect(chatUploadKind("application/pdf")).toBe("document");
    expect(chatUploadKind("text/plain")).toBe("document");
  });
});

describe("isSupportedChatUpload", () => {
  it("accepts images, audio, video, pdf, and text", () => {
    expect(isSupportedChatUpload(file("image/jpeg"))).toBe(true);
    expect(isSupportedChatUpload(file("audio/wav"))).toBe(true);
    expect(isSupportedChatUpload(file("video/webm"))).toBe(true);
    expect(isSupportedChatUpload(file("application/pdf"))).toBe(true);
    expect(isSupportedChatUpload(file("text/csv"))).toBe(true);
  });

  it("rejects unsupported types", () => {
    expect(isSupportedChatUpload(file("application/zip"))).toBe(false);
    expect(isSupportedChatUpload(file(""))).toBe(false);
  });
});

describe("CHAT_UPLOAD_ACCEPT", () => {
  it("covers each supported family", () => {
    expect(CHAT_UPLOAD_ACCEPT).toContain("image/*");
    expect(CHAT_UPLOAD_ACCEPT).toContain("audio/*");
    expect(CHAT_UPLOAD_ACCEPT).toContain("video/*");
    expect(CHAT_UPLOAD_ACCEPT).toContain("application/pdf");
  });
});

describe("createImageThumbnail (guards)", () => {
  it("returns null for non-raster / unthumbnailable types", async () => {
    expect(
      await createImageThumbnail(sizedFile("text/plain", 1_000_000)),
    ).toBeNull();
    expect(
      await createImageThumbnail(sizedFile("application/pdf", 1_000_000)),
    ).toBeNull();
    expect(
      await createImageThumbnail(sizedFile("image/gif", 1_000_000)),
    ).toBeNull();
    expect(
      await createImageThumbnail(sizedFile("image/svg+xml", 1_000_000)),
    ).toBeNull();
  });

  it("returns null for images below the size threshold", async () => {
    expect(await createImageThumbnail(sizedFile("image/png", 1024))).toBeNull();
  });
});

describe("partitionAttachmentFiles", () => {
  it("keeps files under the per-file cap", () => {
    const files = [
      namedFile("a.png", 1_000),
      namedFile("b.png", 2_000),
      namedFile("c.png", 3_000),
    ];
    const result = partitionAttachmentFiles(files);
    expect(result.accepted.map((f) => f.name)).toEqual([
      "a.png",
      "b.png",
      "c.png",
    ]);
    expect(result.droppedTooLarge).toEqual([]);
    expect(result.droppedOverCount).toEqual([]);
  });

  it("drops a single file over the per-file cap and reports it as too-large", () => {
    const files = [
      namedFile("small.png", 1_000),
      namedFile("huge.png", MAX_ATTACHMENT_BYTES + 1),
    ];
    const result = partitionAttachmentFiles(files);
    expect(result.accepted.map((f) => f.name)).toEqual(["small.png"]);
    expect(result.droppedTooLarge).toEqual([
      { name: "huge.png", reason: "too-large" },
    ]);
    expect(result.droppedOverCount).toEqual([]);
  });

  it("keeps a file that is exactly at the per-file cap (boundary)", () => {
    const result = partitionAttachmentFiles([
      namedFile("exact.png", MAX_ATTACHMENT_BYTES),
    ]);
    expect(result.accepted.map((f) => f.name)).toEqual(["exact.png"]);
    expect(result.droppedTooLarge).toEqual([]);
  });

  it("handles a mix of acceptable and oversized files", () => {
    const files = [
      namedFile("ok1.png", 1_000),
      namedFile("too-big.png", MAX_ATTACHMENT_BYTES + 1),
      namedFile("ok2.png", 2_000),
    ];
    const result = partitionAttachmentFiles(files);
    expect(result.accepted.map((f) => f.name)).toEqual(["ok1.png", "ok2.png"]);
    expect(result.droppedTooLarge.map((d) => d.name)).toEqual(["too-big.png"]);
    expect(result.droppedOverCount).toEqual([]);
  });

  it("reports files beyond the count cap as over-count", () => {
    const files = Array.from({ length: MAX_CHAT_IMAGES + 2 }, (_, i) =>
      namedFile(`f${i}.png`, 1_000),
    );
    const result = partitionAttachmentFiles(files);
    expect(result.accepted).toHaveLength(MAX_CHAT_IMAGES);
    expect(result.droppedOverCount).toHaveLength(2);
    expect(
      result.droppedOverCount.every((d) => d.reason === "over-count"),
    ).toBe(true);
    expect(result.droppedTooLarge).toEqual([]);
  });

  it("accounts for already-pending attachments against the count cap", () => {
    const files = [namedFile("a.png", 1_000), namedFile("b.png", 1_000)];
    const result = partitionAttachmentFiles(files, {
      existingCount: MAX_CHAT_IMAGES - 1,
    });
    expect(result.accepted.map((f) => f.name)).toEqual(["a.png"]);
    expect(result.droppedOverCount.map((d) => d.name)).toEqual(["b.png"]);
  });

  it("drops files that overflow the combined total byte cap as too-large", () => {
    // Each file is under the per-file cap, but four of them exceed the total
    // cap, so the file that tips the running total past the cap is dropped.
    const eighteenMb = 18 * 1024 * 1024;
    expect(eighteenMb).toBeLessThan(MAX_ATTACHMENT_BYTES);
    const files = [
      namedFile("a.png", eighteenMb),
      namedFile("b.png", eighteenMb),
      namedFile("c.png", eighteenMb),
      namedFile("d.png", eighteenMb),
    ];
    // 3 × 18MB = 54MB fits under 60MB; the 4th would make 72MB → dropped.
    expect(eighteenMb * 3).toBeLessThanOrEqual(MAX_ATTACHMENTS_TOTAL_BYTES);
    expect(eighteenMb * 4).toBeGreaterThan(MAX_ATTACHMENTS_TOTAL_BYTES);
    const result = partitionAttachmentFiles(files);
    expect(result.accepted.map((f) => f.name)).toEqual([
      "a.png",
      "b.png",
      "c.png",
    ]);
    expect(result.droppedTooLarge.map((d) => d.name)).toEqual(["d.png"]);
  });

  it("treats a missing size as 0 (kept)", () => {
    const noSize = { name: "unknown.png", type: "image/png" } as File;
    const result = partitionAttachmentFiles([noSize]);
    expect(result.accepted.map((f) => f.name)).toEqual(["unknown.png"]);
  });
});

describe("summarizeDroppedAttachments", () => {
  it("returns null when nothing was dropped", () => {
    expect(
      summarizeDroppedAttachments({
        acceptedCount: 3,
        droppedTooLarge: [],
        droppedOverCount: [],
      }),
    ).toBeNull();
  });

  it("counts kept and dropped across both reasons", () => {
    const summary = summarizeDroppedAttachments({
      acceptedCount: 2,
      droppedTooLarge: [{ name: "a", reason: "too-large" }],
      droppedOverCount: [{ name: "b", reason: "over-count" }],
    });
    expect(summary).toEqual({
      kept: 2,
      dropped: 2,
      droppedTooLarge: 1,
      droppedOverCount: 1,
      maxMb: bytesToMb(MAX_ATTACHMENT_BYTES),
    });
  });
});

describe("shouldConvertPasteToAttachment", () => {
  it("returns false for text below the threshold", () => {
    expect(shouldConvertPasteToAttachment("hello")).toBe(false);
    expect(
      shouldConvertPasteToAttachment(
        "x".repeat(LARGE_PASTE_CHAR_THRESHOLD - 1),
      ),
    ).toBe(false);
  });

  it("returns true for text at or above the threshold", () => {
    expect(
      shouldConvertPasteToAttachment("x".repeat(LARGE_PASTE_CHAR_THRESHOLD)),
    ).toBe(true);
    expect(
      shouldConvertPasteToAttachment(
        "x".repeat(LARGE_PASTE_CHAR_THRESHOLD + 50),
      ),
    ).toBe(true);
  });

  it("uses the trimmed length so surrounding whitespace doesn't tip it over", () => {
    const justUnder = "x".repeat(LARGE_PASTE_CHAR_THRESHOLD - 1);
    const padded = `   \n${justUnder}\n   `;
    // Raw length is over the threshold, but the trimmed content is not.
    expect(padded.length).toBeGreaterThanOrEqual(LARGE_PASTE_CHAR_THRESHOLD);
    expect(shouldConvertPasteToAttachment(padded)).toBe(false);
  });

  it("counts trimmed length so leading/trailing whitespace is ignored when large", () => {
    const big = "x".repeat(LARGE_PASTE_CHAR_THRESHOLD);
    expect(shouldConvertPasteToAttachment(`  ${big}  `)).toBe(true);
  });

  it("does not convert a single long URL (a link, not a document)", () => {
    const longUrl = `https://example.com/${"a".repeat(LARGE_PASTE_CHAR_THRESHOLD)}`;
    expect(longUrl.length).toBeGreaterThanOrEqual(LARGE_PASTE_CHAR_THRESHOLD);
    expect(shouldConvertPasteToAttachment(longUrl)).toBe(false);
  });

  it("does convert a long block that merely contains a URL", () => {
    const block = `See https://example.com here\n${"word ".repeat(
      LARGE_PASTE_CHAR_THRESHOLD,
    )}`;
    expect(shouldConvertPasteToAttachment(block)).toBe(true);
  });
});

describe("pastedTextToAttachment", () => {
  it("round-trips ASCII text through base64", () => {
    const text = "hello world\nline two".repeat(200);
    const att = pastedTextToAttachment(text);
    expect(decodeAttachmentText(att.data)).toBe(text);
  });

  it("round-trips non-ASCII / emoji text without corruption", () => {
    const text = `日本語テキスト 🚀✨ — café naïve résumé\n${"漢字".repeat(2000)} 😀`;
    const att = pastedTextToAttachment(text);
    expect(decodeAttachmentText(att.data)).toBe(text);
  });

  it("sets mimeType to text/markdown and a default name", () => {
    const att = pastedTextToAttachment("anything large enough");
    expect(att.mimeType).toBe("text/markdown");
    expect(att.name).toBe("pasted-text.md");
    expect(att.thumbnail).toBeUndefined();
  });

  it("honors a provided name", () => {
    const att = pastedTextToAttachment("body", { name: "snippet.md" });
    expect(att.name).toBe("snippet.md");
  });

  it("does not include a data-URL prefix in data", () => {
    const att = pastedTextToAttachment("plain content");
    expect(att.data.startsWith("data:")).toBe(false);
  });
});

describe("buildDroppedAttachmentNotice", () => {
  const t = (key: string, options?: Record<string, unknown>): string =>
    `${key}|${JSON.stringify(options ?? {})}`;

  it("returns null when nothing was dropped", () => {
    expect(
      buildDroppedAttachmentNotice(
        { acceptedCount: 1, droppedTooLarge: [], droppedOverCount: [] },
        t,
      ),
    ).toBeNull();
  });

  it("uses the too-large key with kept/dropped/maxMb params", () => {
    const notice = buildDroppedAttachmentNotice(
      {
        acceptedCount: 2,
        droppedTooLarge: [{ name: "x", reason: "too-large" }],
        droppedOverCount: [],
      },
      t,
    );
    expect(notice).toContain("chat.attachmentsKeptDroppedTooLarge");
    expect(notice).toContain('"kept":2');
    expect(notice).toContain('"dropped":1');
    expect(notice).toContain(`"maxMb":${bytesToMb(MAX_ATTACHMENT_BYTES)}`);
  });

  it("uses the over-count key when only the count cap tripped", () => {
    const notice = buildDroppedAttachmentNotice(
      {
        acceptedCount: 4,
        droppedTooLarge: [],
        droppedOverCount: [{ name: "y", reason: "over-count" }],
      },
      t,
    );
    expect(notice).toContain("chat.attachmentsKeptDroppedOverCount");
  });

  it("uses the mixed key when both reasons are present", () => {
    const notice = buildDroppedAttachmentNotice(
      {
        acceptedCount: 1,
        droppedTooLarge: [{ name: "x", reason: "too-large" }],
        droppedOverCount: [{ name: "y", reason: "over-count" }],
      },
      t,
    );
    expect(notice).toContain("chat.attachmentsKeptDroppedMixed");
    expect(notice).toContain('"tooLarge":1');
    expect(notice).toContain('"overCount":1');
  });
});

describe("resolveComposerPaste", () => {
  /** Minimal DataTransfer stand-in: files list + getData("text"). */
  const clip = (opts: { files?: File[]; text?: string }) =>
    ({
      files: (opts.files ?? []) as unknown as FileList,
      getData: (type: string) => (type === "text" ? (opts.text ?? "") : ""),
    }) as unknown as Pick<DataTransfer, "files" | "getData">;

  it("routes pasted files to the files action (screenshots/attachments)", () => {
    const png = { type: "image/png", name: "shot.png" } as File;
    const action = resolveComposerPaste(clip({ files: [png] }));
    expect(action.kind).toBe("files");
    if (action.kind === "files") {
      expect(action.files).toHaveLength(1);
    }
  });

  it("files take precedence over any accompanying text", () => {
    const png = { type: "image/png", name: "shot.png" } as File;
    const action = resolveComposerPaste(
      clip({ files: [png], text: "x".repeat(LARGE_PASTE_CHAR_THRESHOLD + 1) }),
    );
    expect(action.kind).toBe("files");
  });

  it("collapses a large text paste into a text attachment", () => {
    const text = "x".repeat(LARGE_PASTE_CHAR_THRESHOLD + 1);
    const action = resolveComposerPaste(clip({ text }));
    expect(action.kind).toBe("text-attachment");
    if (action.kind === "text-attachment") {
      expect(action.attachment.mimeType).toBe("text/markdown");
      expect(decodeAttachmentText(action.attachment.data)).toBe(text);
    }
  });

  it("ignores a small text paste (textarea handles it)", () => {
    expect(resolveComposerPaste(clip({ text: "hi" })).kind).toBe("ignore");
  });

  it("ignores an empty/absent clipboard", () => {
    expect(resolveComposerPaste(null).kind).toBe("ignore");
    expect(resolveComposerPaste(clip({})).kind).toBe("ignore");
  });
});
