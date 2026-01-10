/**
 * PDF Service
 *
 * Provides PDF reading and text extraction functionality.
 */

import {
  type IAgentRuntime,
  Service,
  type ServiceTypeName,
  ServiceType,
  logger,
} from "@elizaos/core";
import pkg from "pdfjs-dist";
const { getDocument } = pkg;
import type { TextItem, TextMarkedContent } from "pdfjs-dist/types/src/display/api";

import type {
  PdfConversionResult,
  PdfExtractionOptions,
  PdfPageInfo,
  PdfDocumentInfo,
  PdfMetadata,
} from "../types";

/**
 * Type guard for TextItem.
 */
function isTextItem(item: TextItem | TextMarkedContent): item is TextItem {
  return "str" in item;
}

/**
 * PDF Service for elizaOS.
 *
 * Provides PDF reading and text extraction capabilities.
 */
export class PdfService extends Service {
  static serviceType: ServiceTypeName = ServiceType.PDF;
  capabilityDescription = "The agent is able to convert PDF files to text";

  constructor(runtime: IAgentRuntime) {
    super();
    this.runtime = runtime;
  }

  /**
   * Initialize the PDF service.
   */
  static async start(runtime: IAgentRuntime): Promise<PdfService> {
    const service = new PdfService(runtime);
    return service;
  }

  /**
   * Stop the PDF service.
   */
  static async stop(runtime: IAgentRuntime): Promise<void> {
    const service = runtime.getService(ServiceType.PDF);
    if (service) {
      await service.stop();
    }
  }

  /**
   * Stop the service.
   */
  async stop(): Promise<void> {
    // Nothing to clean up
  }

  /**
   * Convert a PDF buffer to text.
   */
  async convertPdfToText(pdfBuffer: Buffer): Promise<string> {
    try {
      const uint8Array = new Uint8Array(pdfBuffer);
      const pdf = await getDocument({ data: uint8Array }).promise;
      const numPages = pdf.numPages;

      const textPages: string[] = [];

      for (let pageNum = 1; pageNum <= numPages; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        const pageText = textContent.items
          .filter(isTextItem)
          .map((item: TextItem) => item.str)
          .join(" ");
        textPages.push(pageText);
      }

      const rawText = textPages.join("\n");
      return this.cleanUpContent(rawText);
    } catch (error) {
      logger.error(
        `PdfService: Failed to convert PDF to text - error: ${error}, bufferSize: ${pdfBuffer.length}, runtimeId: ${this.runtime?.agentId || "unknown"}`
      );
      throw error;
    }
  }

  /**
   * Convert a PDF buffer to text with options.
   */
  async convertPdfToTextWithOptions(
    pdfBuffer: Buffer,
    options: PdfExtractionOptions = {}
  ): Promise<PdfConversionResult> {
    try {
      const uint8Array = new Uint8Array(pdfBuffer);
      const pdf = await getDocument({ data: uint8Array }).promise;
      const numPages = pdf.numPages;

      const startPage = Math.max(1, options.startPage || 1);
      const endPage = Math.min(numPages, options.endPage || numPages);

      const textPages: string[] = [];

      for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
        const page = await pdf.getPage(pageNum);
        const textContent = await page.getTextContent();
        const pageText = textContent.items
          .filter(isTextItem)
          .map((item: TextItem) => item.str)
          .join(options.preserveWhitespace ? "" : " ");
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
        error: error instanceof Error ? error.message : "Unknown error occurred",
      };
    }
  }

  /**
   * Get full document information including per-page text.
   */
  async getDocumentInfo(pdfBuffer: Buffer): Promise<PdfDocumentInfo> {
    const uint8Array = new Uint8Array(pdfBuffer);
    const pdf = await getDocument({ data: uint8Array }).promise;
    const numPages = pdf.numPages;

    // Get metadata
    const metadataResult = await pdf.getMetadata();
    const info = metadataResult.info as Record<string, string | Date | undefined>;
    
    const metadata: PdfMetadata = {
      title: info.Title as string | undefined,
      author: info.Author as string | undefined,
      subject: info.Subject as string | undefined,
      keywords: info.Keywords as string | undefined,
      creator: info.Creator as string | undefined,
      producer: info.Producer as string | undefined,
      creationDate: info.CreationDate ? new Date(info.CreationDate as string) : undefined,
      modificationDate: info.ModDate ? new Date(info.ModDate as string) : undefined,
    };

    const pages: PdfPageInfo[] = [];
    const allText: string[] = [];

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale: 1.0 });
      const textContent = await page.getTextContent();

      const pageText = textContent.items
        .filter(isTextItem)
        .map((item: TextItem) => item.str)
        .join(" ");

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

  /**
   * Clean up PDF text content by removing problematic characters.
   */
  cleanUpContent(content: string): string {
    try {
      // Filter out null characters and other problematic control characters
      const filtered = content
        .split("")
        .filter((char) => {
          const charCode = char.charCodeAt(0);
          // Keep all characters except control characters (0-31 and 127)
          // but preserve tab (9), newline (10), and carriage return (13)
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
        // Collapse spaces and tabs but preserve newlines
        .replace(/[^\S\r\n]+/g, " ")
        // Trim trailing spaces at end of lines
        .replace(/[ \t]+(\r?\n)/g, "$1")
        // Trim whitespace from start and end
        .trim();

      return cleaned;
    } catch (error) {
      logger.error(
        `PdfService: Failed to clean up content - error: ${error}, contentLength: ${content.length}`
      );
      // Return original content if cleanup fails
      return content;
    }
  }
}

export default PdfService;

