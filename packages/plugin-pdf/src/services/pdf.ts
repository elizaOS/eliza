import {
  type IAgentRuntime,
  type IPdfService,
  Service,
  type ServiceTypeName,
  ServiceType,
} from '@elizaos/core';
import { type PDFDocumentProxy, getDocument } from 'pdfjs-dist';
import type { TextItem, TextMarkedContent } from 'pdfjs-dist/types/src/display/api';

/**
 * Class representing a PDF service that can convert PDF files to text.
 * * @extends Service
 * @implements IPdfService
 */
export class PdfService extends Service implements IPdfService {
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
    // Convert Buffer to Uint8Array
    const uint8Array = new Uint8Array(pdfBuffer);

    const pdf: PDFDocumentProxy = await getDocument({ data: uint8Array }).promise;
    const numPages = pdf.numPages;
    const textPages: string[] = [];

    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .filter(isTextItem)
        .map((item) => item.str)
        .join(' ');
      textPages.push(pageText);
    }

    return textPages.join('\n');
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
