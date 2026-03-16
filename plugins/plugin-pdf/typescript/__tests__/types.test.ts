import { describe, expect, it } from "vitest";
import type {
  PdfConversionResult,
  PdfDocumentInfo,
  PdfExtractionOptions,
  PdfMetadata,
  PdfPageInfo,
} from "../types";

describe("PDF Plugin Types", () => {
  describe("PdfConversionResult", () => {
    it("should accept valid successful result", () => {
      const result: PdfConversionResult = {
        success: true,
        text: "Sample PDF content",
        pageCount: 5,
      };
      expect(result.success).toBe(true);
      expect(result.text).toBe("Sample PDF content");
      expect(result.pageCount).toBe(5);
    });

    it("should accept error result", () => {
      const result: PdfConversionResult = {
        success: false,
        error: "Failed to parse PDF",
      };
      expect(result.success).toBe(false);
      expect(result.error).toBe("Failed to parse PDF");
    });
  });

  describe("PdfExtractionOptions", () => {
    it("should accept page range options", () => {
      const options: PdfExtractionOptions = {
        startPage: 1,
        endPage: 10,
        preserveWhitespace: true,
        cleanContent: false,
      };
      expect(options.startPage).toBe(1);
      expect(options.endPage).toBe(10);
    });

    it("should accept empty options", () => {
      const options: PdfExtractionOptions = {};
      expect(options.startPage).toBeUndefined();
    });
  });

  describe("PdfPageInfo", () => {
    it("should represent page information", () => {
      const page: PdfPageInfo = {
        pageNumber: 1,
        width: 612,
        height: 792,
        text: "Page content here",
      };
      expect(page.pageNumber).toBe(1);
      expect(page.width).toBe(612);
      expect(page.height).toBe(792);
    });
  });

  describe("PdfMetadata", () => {
    it("should represent document metadata", () => {
      const metadata: PdfMetadata = {
        title: "Test Document",
        author: "Test Author",
        subject: "Testing",
        keywords: "test, pdf, document",
      };
      expect(metadata.title).toBe("Test Document");
      expect(metadata.author).toBe("Test Author");
    });
  });

  describe("PdfDocumentInfo", () => {
    it("should represent full document info", () => {
      const doc: PdfDocumentInfo = {
        pageCount: 2,
        metadata: { title: "Test" },
        text: "Full text content",
        pages: [
          { pageNumber: 1, width: 612, height: 792, text: "Page 1" },
          { pageNumber: 2, width: 612, height: 792, text: "Page 2" },
        ],
      };
      expect(doc.pageCount).toBe(2);
      expect(doc.pages.length).toBe(2);
    });
  });
});
