/**
 * Unit tests for document image upload utilities in packages/shared/src/utils/documents-upload-image.ts.
 * Exercises MIME type and file extension detection, processing size thresholds, and image compression bypass paths.
 */
import { describe, expect, it } from "vitest";
import {
  type DocumentImageCompressionPlatform,
  DocumentImageCompressionUnavailableError,
  type DocumentImageUploadFile,
  isDocumentImageFile,
  MAX_DOCUMENT_IMAGE_PROCESSING_BYTES,
  maybeCompressDocumentUploadImage,
} from "./documents-upload-image.js";

describe("documents-upload-image utilities", () => {
  describe("isDocumentImageFile", () => {
    it("identifies image files by MIME type", () => {
      expect(
        isDocumentImageFile({ name: "document.bin", type: "image/png" }),
      ).toBe(true);
      expect(
        isDocumentImageFile({ name: "upload.dat", type: "image/jpeg" }),
      ).toBe(true);
      expect(
        isDocumentImageFile({ name: "picture.dat", type: "image/webp" }),
      ).toBe(true);
      expect(
        isDocumentImageFile({ name: "graphic.dat", type: "image/gif" }),
      ).toBe(true);
    });

    it("identifies image files by extension when MIME type is generic or empty", () => {
      expect(
        isDocumentImageFile({
          name: "screenshot.png",
          type: "application/octet-stream",
        }),
      ).toBe(true);
      expect(isDocumentImageFile({ name: "photo.jpg", type: "" })).toBe(true);
      expect(isDocumentImageFile({ name: "photo.JPEG", type: "" })).toBe(true);
      expect(isDocumentImageFile({ name: "graphic.webp", type: "" })).toBe(
        true,
      );
      expect(isDocumentImageFile({ name: "animation.gif", type: "" })).toBe(
        true,
      );
    });

    it("returns false for non-image files", () => {
      expect(
        isDocumentImageFile({
          name: "contract.pdf",
          type: "application/pdf",
        }),
      ).toBe(false);
      expect(
        isDocumentImageFile({ name: "notes.txt", type: "text/plain" }),
      ).toBe(false);
      expect(
        isDocumentImageFile({
          name: "archive.zip",
          type: "application/zip",
        }),
      ).toBe(false);
      expect(
        isDocumentImageFile({
          name: "spreadsheet.xlsx",
          type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }),
      ).toBe(false);
    });
  });

  describe("MAX_DOCUMENT_IMAGE_PROCESSING_BYTES", () => {
    it("exports the 5MB processing threshold (5,242,880 bytes)", () => {
      expect(MAX_DOCUMENT_IMAGE_PROCESSING_BYTES).toBe(5 * 1024 * 1024);
    });
  });

  describe("maybeCompressDocumentUploadImage", () => {
    it("skips non-image files without attempting compression", async () => {
      const nonImageFile = new File(["dummy pdf content"], "doc.pdf", {
        type: "application/pdf",
      }) as DocumentImageUploadFile;

      const result = await maybeCompressDocumentUploadImage(nonImageFile);
      expect(result.optimized).toBe(false);
      expect(result.file).toBe(nonImageFile);
      expect(result.originalSize).toBe(nonImageFile.size);
      expect(result.optimizedSize).toBe(nonImageFile.size);
    });

    it("skips images within size threshold", async () => {
      const smallImageFile = new File(["small image data"], "image.png", {
        type: "image/png",
      }) as DocumentImageUploadFile;

      const result = await maybeCompressDocumentUploadImage(smallImageFile);
      expect(result.optimized).toBe(false);
      expect(result.file).toBe(smallImageFile);
    });

    it("returns unoptimized when compression platform is unavailable", async () => {
      const mockPlatform: DocumentImageCompressionPlatform = {
        isAvailable: () => false,
        loadImageSource: async () => ({
          source: {} as CanvasImageSource,
          width: 3000,
          height: 2000,
        }),
        renderBlob: async () => new Blob(["compressed"]),
      };

      const largeImageBytes = new Uint8Array(
        MAX_DOCUMENT_IMAGE_PROCESSING_BYTES + 1024,
      );
      const largeImageFile = new File([largeImageBytes], "large.jpg", {
        type: "image/jpeg",
      }) as DocumentImageUploadFile;

      const result = await maybeCompressDocumentUploadImage(
        largeImageFile,
        mockPlatform,
      );
      expect(result.optimized).toBe(false);
      expect(result.file).toBe(largeImageFile);
    });

    it("returns the exact original file for an expected decode failure", async () => {
      const file = new File(
        [new Uint8Array(MAX_DOCUMENT_IMAGE_PROCESSING_BYTES + 1)],
        "scan.png",
        { type: "image/png", lastModified: 123 },
      ) as DocumentImageUploadFile;
      const mockPlatform: DocumentImageCompressionPlatform = {
        isAvailable: () => true,
        loadImageSource: async () => {
          throw new DocumentImageCompressionUnavailableError("decode failed");
        },
        renderBlob: async () => new Blob(),
      };

      const result = await maybeCompressDocumentUploadImage(file, mockPlatform);
      expect(result).toEqual({
        file,
        optimized: false,
        originalSize: file.size,
        optimizedSize: file.size,
      });
    });

    it("returns the exact original file for an expected encode failure", async () => {
      const file = new File(
        [new Uint8Array(MAX_DOCUMENT_IMAGE_PROCESSING_BYTES + 1)],
        "scan.png",
        { type: "image/png", lastModified: 123 },
      ) as DocumentImageUploadFile;
      const mockPlatform: DocumentImageCompressionPlatform = {
        isAvailable: () => true,
        loadImageSource: async () => ({
          source: {} as CanvasImageSource,
          width: 100,
          height: 100,
        }),
        renderBlob: async () => {
          throw new DocumentImageCompressionUnavailableError("encode failed");
        },
      };

      const result = await maybeCompressDocumentUploadImage(file, mockPlatform);
      expect(result.file).toBe(file);
      expect(result.optimized).toBe(false);
      expect(result.originalSize).toBe(file.size);
      expect(result.optimizedSize).toBe(file.size);
    });

    it("does not disguise an unexpected platform failure", async () => {
      const file = new File(
        [new Uint8Array(MAX_DOCUMENT_IMAGE_PROCESSING_BYTES + 1)],
        "scan.png",
        { type: "image/png" },
      ) as DocumentImageUploadFile;
      const mockPlatform: DocumentImageCompressionPlatform = {
        isAvailable: () => true,
        loadImageSource: async () => ({
          source: {} as CanvasImageSource,
          width: 100,
          height: 100,
        }),
        renderBlob: async () => {
          throw new TypeError("programming failure");
        },
      };

      await expect(
        maybeCompressDocumentUploadImage(file, mockPlatform),
      ).rejects.toThrow("programming failure");
    });
  });
});
