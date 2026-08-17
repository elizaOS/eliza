/**
 * Unit tests for documents upload image helpers in packages/shared/src/utils/documents-upload-image.ts.
 * Exercises MIME type detection, extension fallbacks, size threshold skips,
 * MAX_DOCUMENT_IMAGE_PROCESSING_BYTES export, and non-object inputs.
 */
import { describe, expect, it } from "vitest";
import {
  MAX_DOCUMENT_IMAGE_PROCESSING_BYTES,
  isDocumentImageFile,
  maybeCompressDocumentUploadImage,
} from "./documents-upload-image.js";

describe("isDocumentImageFile", () => {
  it("identifies image files by MIME type", () => {
    expect(isDocumentImageFile({ name: "file", type: "image/png" })).toBe(true);
    expect(isDocumentImageFile({ name: "doc", type: "image/jpeg" })).toBe(true);
    expect(isDocumentImageFile({ name: "photo", type: "image/webp" })).toBe(
      true,
    );
    expect(isDocumentImageFile({ name: "anim", type: "image/gif" })).toBe(true);
  });

  it("identifies image files by extension when MIME type is absent or generic", () => {
    expect(isDocumentImageFile({ name: "photo.jpg", type: "" })).toBe(true);
    expect(
      isDocumentImageFile({
        name: "photo.JPEG",
        type: "application/octet-stream",
      }),
    ).toBe(true);
    expect(isDocumentImageFile({ name: "image.png", type: "" })).toBe(true);
    expect(isDocumentImageFile({ name: "graphic.webp", type: "" })).toBe(true);
    expect(isDocumentImageFile({ name: "clip.gif", type: "" })).toBe(true);
  });

  it("returns false for non-image files", () => {
    expect(
      isDocumentImageFile({ name: "document.pdf", type: "application/pdf" }),
    ).toBe(false);
    expect(isDocumentImageFile({ name: "notes.txt", type: "text/plain" })).toBe(
      false,
    );
    expect(
      isDocumentImageFile({ name: "data.json", type: "application/json" }),
    ).toBe(false);
  });

  it("safely handles null, undefined, and non-object inputs", () => {
    expect(isDocumentImageFile(null)).toBe(false);
    expect(isDocumentImageFile(undefined)).toBe(false);
    expect(isDocumentImageFile(123 as unknown as undefined)).toBe(false);
    expect(isDocumentImageFile({} as unknown as undefined)).toBe(false);
  });
});

describe("MAX_DOCUMENT_IMAGE_PROCESSING_BYTES", () => {
  it("exports the 5MB threshold", () => {
    expect(MAX_DOCUMENT_IMAGE_PROCESSING_BYTES).toBe(5 * 1024 * 1024);
  });
});

describe("maybeCompressDocumentUploadImage", () => {
  it("skips non-image files without attempting compression", async () => {
    const mockFile = {
      name: "doc.pdf",
      type: "application/pdf",
      size: 10 * 1024 * 1024,
    } as unknown as File;

    const result = await maybeCompressDocumentUploadImage(mockFile);
    expect(result.optimized).toBe(false);
    expect(result.file).toBe(mockFile);
  });

  it("skips images within size threshold", async () => {
    const mockFile = {
      name: "photo.jpg",
      type: "image/jpeg",
      size: 2 * 1024 * 1024,
    } as unknown as File;

    const result = await maybeCompressDocumentUploadImage(mockFile);
    expect(result.optimized).toBe(false);
    expect(result.file).toBe(mockFile);
  });
});
