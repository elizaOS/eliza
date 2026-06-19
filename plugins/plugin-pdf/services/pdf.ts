import type { IAgentRuntime } from "@elizaos/core";
import { logger, Service, ServiceType } from "@elizaos/core";
import { getDocumentProxy } from "unpdf";

import type {
  PdfConversionResult,
  PdfDocumentInfo,
  PdfExtractionOptions,
  PdfMetadata,
  PdfPageInfo,
} from "../types";

type PdfTextItem = { str: string };

export const MAX_PDF_BUFFER_BYTES = 100 * 1024 * 1024;

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

function collectTextStrings(items: readonly unknown[]): string[] {
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

  return input;
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
  if (requestedEndPage < requestedStartPage) {
    throw new RangeError("endPage must be greater than or equal to startPage");
  }
  return {
    startPage: Math.min(requestedStartPage, numPages),
    endPage: Math.min(requestedEndPage, numPages),
  };
}

function parseMetadataDate(value: string | Date | undefined): Date | undefined {
  if (value === undefined) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
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
    try {
      const uint8Array = validatePdfInput(pdfBuffer);
      const pdf = await getDocumentProxy(uint8Array);
      const numPages = pdf.numPages;

      const textPages: string[] = [];

      for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        const pageText = collectTextStrings(textContent.items).join(" ");
        textPages.push(pageText);
      }

      const rawText = textPages.join("\n");
      return this.cleanUpContent(rawText);
    } catch (error) {
      const bufferSize = pdfBuffer instanceof Uint8Array ? pdfBuffer.length : "unknown";
      logger.error(
        `PdfService: Failed to convert PDF to text - error: ${error}, bufferSize: ${bufferSize}`
      );
      throw error;
    }
  }

  async convertPdfToTextWithOptions(
    pdfBuffer: Buffer | Uint8Array,
    options: PdfExtractionOptions = {}
  ): Promise<PdfConversionResult> {
    try {
      const uint8Array = validatePdfInput(pdfBuffer);
      const pdf = await getDocumentProxy(uint8Array);
      const numPages = pdf.numPages;

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
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getDocumentInfo(pdfBuffer: Buffer | Uint8Array): Promise<PdfDocumentInfo> {
    const uint8Array = validatePdfInput(pdfBuffer);
    const pdf = await getDocumentProxy(uint8Array);
    const numPages = pdf.numPages;

    const metadataResult = await pdf.getMetadata();
    const info = metadataResult.info as Record<string, string | Date | undefined>;

    const metadata: PdfMetadata = {
      title: info.Title as string | undefined,
      author: info.Author as string | undefined,
      subject: info.Subject as string | undefined,
      keywords: info.Keywords as string | undefined,
      creator: info.Creator as string | undefined,
      producer: info.Producer as string | undefined,
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
    try {
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

      const cleaned = filtered
        .replace(/[^\S\r\n]+/g, " ")
        .replace(/[ \t]+(\r?\n)/g, "$1")
        .trim();

      return cleaned;
    } catch (error) {
      logger.error(
        `PdfService: Failed to clean up content - error: ${error}, contentLength: ${content.length}`
      );
      return content;
    }
  }
}

export default PdfService;
