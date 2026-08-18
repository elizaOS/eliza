/**
 * Exercises the optional document-image compression boundary with valid File
 * objects and explicit expected versus unexpected platform failures.
 */
import { describe, expect, it } from "vitest";
import {
  type DocumentImageCompressionPlatform,
  DocumentImageCompressionUnavailableError,
  MAX_DOCUMENT_IMAGE_PROCESSING_BYTES,
  maybeCompressDocumentUploadImage,
} from "./documents-upload-image.ts";

function largeImage(): File {
  return new File(
    [new Uint8Array(MAX_DOCUMENT_IMAGE_PROCESSING_BYTES + 1)],
    "scan.png",
    {
      type: "image/png",
      lastModified: 123,
    },
  );
}

function platform(
  overrides: Partial<DocumentImageCompressionPlatform>,
): DocumentImageCompressionPlatform {
  return {
    isAvailable: () => true,
    loadImageSource: async () => ({
      source: {} as CanvasImageSource,
      width: 100,
      height: 100,
    }),
    renderBlob: async () =>
      new Blob([new Uint8Array(10)], { type: "image/jpeg" }),
    ...overrides,
  };
}

describe("maybeCompressDocumentUploadImage", () => {
  it("still returns an optimized clone after successful compression", async () => {
    const file = largeImage();
    const result = await maybeCompressDocumentUploadImage(file, platform({}));

    expect(result.file).not.toBe(file);
    expect(result.file.name).toBe(file.name);
    expect(result.file.type).toBe("image/jpeg");
    expect(result.optimized).toBe(true);
    expect(result.originalSize).toBe(file.size);
    expect(result.optimizedSize).toBe(10);
  });

  it("returns the exact original file when image decoding is unavailable", async () => {
    const file = largeImage();
    const result = await maybeCompressDocumentUploadImage(
      file,
      platform({
        loadImageSource: async () => {
          throw new DocumentImageCompressionUnavailableError("decode failed");
        },
      }),
    );

    expect(result).toEqual({
      file,
      optimized: false,
      originalSize: file.size,
      optimizedSize: file.size,
    });
  });

  it("returns the exact original file when canvas encoding is unavailable", async () => {
    const file = largeImage();
    const result = await maybeCompressDocumentUploadImage(
      file,
      platform({
        renderBlob: async () => {
          throw new DocumentImageCompressionUnavailableError("encode failed");
        },
      }),
    );

    expect(result.file).toBe(file);
    expect(result.optimized).toBe(false);
    expect(result.originalSize).toBe(file.size);
    expect(result.optimizedSize).toBe(file.size);
  });

  it("does not disguise an unexpected platform failure", async () => {
    const file = largeImage();
    await expect(
      maybeCompressDocumentUploadImage(
        file,
        platform({
          renderBlob: async () => {
            throw new TypeError("programming failure");
          },
        }),
      ),
    ).rejects.toThrow("programming failure");
  });
});
