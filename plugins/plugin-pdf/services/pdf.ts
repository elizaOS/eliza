/**
 * Implements local PDF input validation, text extraction, metadata parsing,
 * and content cleanup for the runtime PDF service.
 *
 * Declared page counts are fail-closed at {@link MAX_PDF_PAGES} before any
 * per-page `getPage` work. File-size already has {@link MAX_PDF_BUFFER_BYTES};
 * `numPages` is independent attacker-controlled work.
 */

import type { IAgentRuntime } from "@elizaos/core";
import { Service, ServiceType } from "@elizaos/core";
import { getDocumentProxy } from "unpdf";
import { parsePdfSpecDate } from "./pdf-date.ts";

import type {
  PdfConversionResult,
  PdfDocumentInfo,
  PdfExtractionOptions,
  PdfMetadata,
  PdfPageInfo,
} from "../types";

type PdfTextItem = { str: string };

export const MAX_PDF_BUFFER_BYTES = 100 * 1024 * 1024;
/** Fail-closed page budget. `numPages` is attacker-declared, not a file size. */
export const MAX_PDF_PAGES = 2_048;

function requirePdfPageCount(numPages: unknown): number {
  if (typeof numPages !== "number" || !Number.isSafeInteger(numPages) || numPages < 1) {
    throw new RangeError("PDF page count must be a positive safe integer");
  }
  if (numPages > MAX_PDF_PAGES) {
    throw new RangeError(`PDF page count exceeds maximum of ${MAX_PDF_PAGES} pages`);
  }
  return numPages;
}

const PDF_HEADER_BYTES = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;
const PDF_HEADER_SCAN_BYTES = 1024;

function isTextItem(item: unknown): item is PdfTextItem {
  return (
    typeof item === "object" &&
    item !== null &&
    "str" in item &&
    typeof (item as { str?: unknown }).str === "string"
  );
}

function collectTextStrings(items: unknown): string[] {
  if (!Array.isArray(items)) {
    throw new TypeError("PDF text content items must be an array");
  }

  const textItems: string[] = [];
  for (const item of items) {
    if (isTextItem(item)) {
      textItems.push(item.str);
    }
  }
  return textItems;
}

function hasPdfHeader(input: Uint8Array): boolean {
  const scanLength = Math.min(input.length, PDF_HEADER_SCAN_BYTES);
  for (let offset = 0; offset <= scanLength - PDF_HEADER_BYTES.length; offset++) {
    let matches = true;
    for (let index = 0; index < PDF_HEADER_BYTES.length; index++) {
      if (input[offset + index] !== PDF_HEADER_BYTES[index]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      return true;
    }
  }
  return false;
}

function validatePdfInput(input: unknown): Uint8Array {
  if (!(input instanceof Uint8Array)) {
    throw new TypeError("PDF input must be a Buffer or Uint8Array");
  }

  if (input.length === 0) {
    throw new RangeError("PDF input is empty");
  }

  if (input.byteLength > MAX_PDF_BUFFER_BYTES) {
    throw new RangeError(`PDF input exceeds maximum size of ${MAX_PDF_BUFFER_BYTES} bytes`);
  }

  if (!hasPdfHeader(input)) {
    throw new TypeError("PDF input is not a supported PDF document");
  }

  return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
}

function validatePageOption(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    !Number.isInteger(value) ||
    value < 1
  ) {
    throw new RangeError(`${name} must be a positive finite integer`);
  }
  return value;
}

function normalizeExtractionOptions(
  options: PdfExtractionOptions,
  numPages: number
): {
  startPage: number;
  endPage: number;
} {
  const requestedStartPage = validatePageOption(options.startPage, "startPage") ?? 1;
  const requestedEndPage = validatePageOption(options.endPage, "endPage") ?? numPages;
  // Reject a range that begins past the document rather than clamping startPage
  // down to the last page, which would return a different page's text as a
  // success and hide the mismatch behind the full-document pageCount.
  if (requestedStartPage > numPages) {
    throw new RangeError(`startPage ${requestedStartPage} exceeds document page count ${numPages}`);
  }
  if (requestedEndPage < requestedStartPage) {
    throw new RangeError("endPage must be greater than or equal to startPage");
  }
  // startPage is now known in-range; only endPage needs the benign "up to end"
  // clamp so an oversized endPage still extracts through the final page.
  return {
    startPage: requestedStartPage,
    endPage: Math.min(requestedEndPage, numPages),
  };
}

/**
 * PDF spec (ISO 32000-1, 7.9.4) date string: `D:YYYYMMDDHHmmSSOHH'mm'` where
 * every component after the year is optional and `O` is the UT relation
 * (`+`, `-`, or `Z`). This is what `pdf.js`/`unpdf` actually surface in
 * `info.CreationDate`/`info.ModDate`, not an ISO-8601 string. The groups mirror
 * `PDFDateString.toDateObject` in pdf.js so real-world documents round-trip.
 */
export { parsePdfSpecDate } from "./pdf-date.ts";

function parseMetadataDate(value: unknown): Date | undefined {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : undefined;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  // Real unpdf/pdf.js output is the PDF-spec `D:` format; only fall back to the
  // permissive `new Date()` path for actual ISO-8601 / RFC strings.
  if (value.startsWith("D:")) {
    return parsePdfSpecDate(value);
  }

  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : undefined;
}

export class PdfService extends Service {
  static serviceType = ServiceType.PDF;
  capabilityDescription = "The agent is able to convert PDF files to text";

  static async start(runtime: IAgentRuntime): Promise<PdfService> {
    const service = new PdfService(runtime);
    return service;
  }

  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService(ServiceType.PDF);
    if (service) {
      await service.stop();
    }
  }

  async stop(): Promise<void> {}

  async convertPdfToText(pdfBuffer: Buffer | Uint8Array): Promise<string> {
    const uint8Array = validatePdfInput(pdfBuffer);
    const pdf = await getDocumentProxy(uint8Array);
    const numPages = requirePdfPageCount(pdf.numPages);

    const textPages: string[] = [];

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      const pageText = collectTextStrings(textContent.items).join(" ");
      textPages.push(pageText);
    }

    const rawText = textPages.join("\n");
    return this.cleanUpContent(rawText);
  }

  async convertPdfToTextWithOptions(
    pdfBuffer: Buffer | Uint8Array,
    options: PdfExtractionOptions = {}
  ): Promise<PdfConversionResult> {
    try {
      const uint8Array = validatePdfInput(pdfBuffer);
      const pdf = await getDocumentProxy(uint8Array);
      const numPages = requirePdfPageCount(pdf.numPages);

      const { startPage, endPage } = normalizeExtractionOptions(options, numPages);

      const textPages: string[] = [];

      for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        const pageText = collectTextStrings(textContent.items).join(
          options.preserveWhitespace ? "" : " "
        );
        textPages.push(pageText);
      }

      let text = textPages.join("\n");

      if (options.cleanContent !== false) {
        text = this.cleanUpContent(text);
      }

      return {
        success: true,
        text,
        pageCount: numPages,
      };
    } catch (error) {
      // error-policy:J1 PdfConversionResult is this public method's structured failure boundary.
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getDocumentInfo(pdfBuffer: Buffer | Uint8Array): Promise<PdfDocumentInfo> {
    const uint8Array = validatePdfInput(pdfBuffer);
    const pdf = await getDocumentProxy(uint8Array);
    const numPages = requirePdfPageCount(pdf.numPages);

    const metadataResult = await pdf.getMetadata();
    const info =
      typeof metadataResult.info === "object" && metadataResult.info !== null
        ? (metadataResult.info as Record<string, unknown>)
        : {};

    const metadata: PdfMetadata = {
      title: typeof info.Title === "string" ? info.Title : undefined,
      author: typeof info.Author === "string" ? info.Author : undefined,
      subject: typeof info.Subject === "string" ? info.Subject : undefined,
      keywords: typeof info.Keywords === "string" ? info.Keywords : undefined,
      creator: typeof info.Creator === "string" ? info.Creator : undefined,
      producer: typeof info.Producer === "string" ? info.Producer : undefined,
      creationDate: parseMetadataDate(info.CreationDate),
      modificationDate: parseMetadataDate(info.ModDate),
    };

    const pages: PdfPageInfo[] = [];
    const allText: string[] = [];

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1.0 });
      const textContent = await page.getTextContent();

      const pageText = collectTextStrings(textContent.items).join(" ");

      pages.push({
        pageNumber: pageNum,
        width: viewport.width,
        height: viewport.height,
        text: this.cleanUpContent(pageText),
      });

      allText.push(pageText);
    }

    return {
      pageCount: numPages,
      metadata,
      text: this.cleanUpContent(allText.join("\n")),
      pages,
    };
  }

  cleanUpContent(content: string): string {
    const filtered = content
      .split("")
      .filter((char) => {
        const charCode = char.charCodeAt(0);
        return !(
          charCode === 0 ||
          (charCode >= 1 && charCode <= 8) ||
          (charCode >= 11 && charCode <= 12) ||
          (charCode >= 14 && charCode <= 31) ||
          charCode === 127
        );
      })
      .join("");

    return filtered
      .replace(/[^\S\r\n]+/g, " ")
      .replaceAll(" \r\n", "\r\n")
      .replaceAll(" \n", "\n")
      .trim();
  }
}

export default PdfService;
