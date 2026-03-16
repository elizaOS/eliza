import { describe, expect, it, vi } from "vitest";
import {
  getKnowledgeUploadFilename,
  type KnowledgeUploadFile,
  shouldReadKnowledgeFileAsText,
} from "../../src/components/KnowledgeView";
import {
  isKnowledgeImageFile,
  type KnowledgeImageCompressionPlatform,
  MAX_KNOWLEDGE_IMAGE_PROCESSING_BYTES,
  maybeCompressKnowledgeUploadImage,
} from "../../src/components/knowledge-upload-image";

function makeUploadFile(
  name: string,
  type: string,
  relativePath?: string,
): KnowledgeUploadFile {
  const file = new File(["content"], name, { type }) as KnowledgeUploadFile;
  if (relativePath !== undefined) {
    Object.defineProperty(file, "webkitRelativePath", {
      value: relativePath,
      configurable: true,
    });
  }
  return file;
}

describe("knowledge upload helpers", () => {
  it("prefers relative path for folder uploads", () => {
    const file = makeUploadFile("guide.md", "text/markdown", "docs/guide.md");
    expect(getKnowledgeUploadFilename(file)).toBe("docs/guide.md");
  });

  it("falls back to filename for regular uploads", () => {
    const file = makeUploadFile("note.txt", "text/plain");
    expect(getKnowledgeUploadFilename(file)).toBe("note.txt");
  });

  it("detects text-readable knowledge files", () => {
    expect(
      shouldReadKnowledgeFileAsText({
        type: "application/json",
        name: "a.bin",
      }),
    ).toBe(true);
    expect(
      shouldReadKnowledgeFileAsText({
        type: "application/octet-stream",
        name: "notes.md",
      }),
    ).toBe(true);
    expect(
      shouldReadKnowledgeFileAsText({
        type: "application/pdf",
        name: "report.pdf",
      }),
    ).toBe(false);
  });

  it("detects image uploads by mime type or extension", () => {
    expect(isKnowledgeImageFile({ name: "scan.bin", type: "image/png" })).toBe(
      true,
    );
    expect(
      isKnowledgeImageFile({
        name: "scan.WEBP",
        type: "application/octet-stream",
      }),
    ).toBe(true);
    expect(
      isKnowledgeImageFile({ name: "notes.txt", type: "text/plain" }),
    ).toBe(false);
  });

  it("compresses oversized local images before upload", async () => {
    const file = new File(
      [new Uint8Array(MAX_KNOWLEDGE_IMAGE_PROCESSING_BYTES + 1024)],
      "scan.png",
      { type: "image/png" },
    ) as KnowledgeUploadFile;
    Object.defineProperty(file, "webkitRelativePath", {
      value: "images/scan.png",
      configurable: true,
    });

    const platform: KnowledgeImageCompressionPlatform = {
      isAvailable: () => true,
      loadImageSource: vi.fn(async () => ({
        source: {} as CanvasImageSource,
        width: 2400,
        height: 1600,
      })),
      renderBlob: vi
        .fn()
        .mockResolvedValueOnce(
          new Blob([new Uint8Array(4_000_000)], { type: "image/jpeg" }),
        ),
    };

    const result = await maybeCompressKnowledgeUploadImage(file, platform);

    expect(result.optimized).toBe(true);
    expect(result.originalSize).toBeGreaterThan(result.optimizedSize);
    expect(result.file.type).toBe("image/jpeg");
    expect(result.file.name).toBe("scan.png");
    expect(result.file.webkitRelativePath).toBe("images/scan.png");
  });

  it("leaves non-image uploads unchanged", async () => {
    const file = makeUploadFile("notes.md", "text/markdown");
    const platform: KnowledgeImageCompressionPlatform = {
      isAvailable: () => true,
      loadImageSource: vi.fn(),
      renderBlob: vi.fn(),
    };

    const result = await maybeCompressKnowledgeUploadImage(file, platform);

    expect(result.optimized).toBe(false);
    expect(result.file).toBe(file);
    expect(platform.loadImageSource).not.toHaveBeenCalled();
  });
});
