import { type IAgentRuntime, Service, type ServiceTypeName, ServiceType, logger } from '@elizaos/core';
import pkg from 'pdfjs-dist';
const { getDocument } = pkg;
import type { TextItem, TextMarkedContent } from 'pdfjs-dist/types/src/display/api';

/**
 * Class representing a PDF service that can convert PDF files to text.
 * * @extends Service
 */
export class PdfService extends Service {
  static serviceType: ServiceTypeName = ServiceType.PDF;
  capabilityDescription = 'The agent is able to convert PDF files to text';

  /**
   * Constructor for creating a new instance of the class.
   *
   * @param {IAgentRuntime} runtime - The runtime object passed to the constructor.
   */
  constructor(runtime: IAgentRuntime) {
    super();
    this.runtime = runtime;
  }

  /**
   * Starts the PdfService asynchronously.
   * @param {IAgentRuntime} runtime - The runtime object for the agent.
   * @returns {Promise<PdfService>} A promise that resolves with the PdfService instance.
   */
  static async start(runtime: IAgentRuntime): Promise<PdfService> {
    const service = new PdfService(runtime);
    return service;
  }

  /**
   * Stop the PDF service in the given runtime.
   *
   * @param {IAgentRuntime} runtime - The runtime to stop the PDF service in.
   * @returns {Promise<void>} - A promise that resolves once the PDF service is stopped.
   */
  static async stop(runtime: IAgentRuntime) {
    const service = runtime.getService(ServiceType.PDF);
    if (service) {
      await service.stop();
    }
  }

  /**
   * Asynchronously stops the process.
   * Does nothing.
   */
  async stop() {
    // do nothing
  }

  /**
   * Converts a PDF Buffer to text.
   *
   * @param {Buffer} pdfBuffer - The PDF Buffer to convert to text.
   * @returns {Promise<string>} A Promise that resolves with the text content of the PDF.
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
          .join(' ');
        textPages.push(pageText);
      }
      const rawText = textPages.join('\n');

      return this.cleanUpContent(rawText);
    } catch (error) {
      logger.error(`PdfService: Failed to convert PDF to text - error: ${error}, bufferSize: ${pdfBuffer.length}, runtimeId: ${this.runtime?.agentId || 'unknown'}`);
      throw error;
    }
  }

  /**
   * Cleans up PDF text content by removing problematic characters.
   *
   * @param {string} content - The raw text content from PDF.
   * @returns {string} The cleaned text content.
   */
  cleanUpContent(content: string): string {
    try {
      // Filter out null characters and other problematic control characters
      const filtered = content
        .split('')
        .filter(char => {
          const charCode = char.charCodeAt(0);
          // Keep all characters except control characters (0-31 and 127)
          // but preserve tab (9), newline (10), and carriage return (13)
          return !(charCode === 0 ||
            (charCode >= 1 && charCode <= 8) ||
            (charCode >= 11 && charCode <= 12) ||
            (charCode >= 14 && charCode <= 31) ||
            charCode === 127);
        })
        .join('');

      const cleaned = filtered
        // Collapse spaces and tabs but preserve newlines
        .replace(/[^\S\r\n]+/g, ' ')
        // Trim trailing spaces at end of lines
        .replace(/[ \t]+(\r?\n)/g, '$1')
        // Trim whitespace from start and end
        .trim();

      return cleaned;
    } catch (error) {
      logger.error(`PdfService: Failed to clean up content - error: ${error}, contentLength: ${content.length}`);
      // Return original content if cleanup fails
      return content;
    }
  }
}

// Type guard function
/**
 * Check if the input is a TextItem.
 *
 * @param item - The input item to check.
 * @returns A boolean indicating if the input is a TextItem.
 */
function isTextItem(item: TextItem | TextMarkedContent): item is TextItem {
  return 'str' in item;
}
