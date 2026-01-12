import type { IAgentRuntime } from "@elizaos/core";
import { logger, Service, ServiceType } from "@elizaos/core";
import pkg from "pdfjs-dist";

const { getDocument } = pkg;

import type { TextItem, TextMarkedContent } from "pdfjs-dist/types/src/display/api";

import type {
  PdfConversionResult,
  PdfDocumentInfo,
  PdfExtractionOptions,
  PdfMetadata,
  PdfPageInfo,
} from "../types";

function isTextItem(item: TextItem | TextMarkedContent): item is TextItem {
  return "str" in item;
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
        `PdfService: Failed to convert PDF to text - error: ${error}, bufferSize: ${pdfBuffer.length}`
      );
      throw error;
    }
  }

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
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async getDocumentInfo(pdfBuffer: Buffer): Promise<PdfDocumentInfo> {
    const uint8Array = new Uint8Array(pdfBuffer);
    const pdf = await getDocument({ data: uint8Array }).promise;
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
