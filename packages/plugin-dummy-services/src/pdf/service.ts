import { IAgentRuntime, Service, ServiceType, logger } from '@elizaos/core';

// Define PDF-specific types locally since they're not in core
export interface PdfExtractionResult {
  text: string;
  metadata?: {
    title?: string;
    author?: string;
    pages?: number;
    creationDate?: Date;
  };
}

export interface PdfGenerationOptions {
  format?: 'A4' | 'Letter' | 'Legal';
  margin?: {
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
  };
}

export interface PdfConversionOptions {
  quality?: number;
  dpi?: number;
}

/**
 * Dummy PDF service for testing purposes
 * Provides mock implementations of PDF operations
 */
export class DummyPdfService extends Service {
  static readonly serviceType = ServiceType.PDF;

  capabilityDescription = 'Dummy PDF service for testing';

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<DummyPdfService> {
    const service = new DummyPdfService(runtime);
    await service.initialize();
    return service;
  }

  async initialize(): Promise<void> {
    logger.info('DummyPdfService initialized');
  }

  async stop(): Promise<void> {
    logger.info('DummyPdfService stopped');
  }

  async extractText(pdfBuffer: Buffer): Promise<PdfExtractionResult> {
    logger.debug(`Extracting text from PDF (${pdfBuffer.length} bytes)`);

    return {
      text: 'This is dummy extracted text from the PDF document.',
      metadata: {
        title: 'Dummy PDF Document',
        author: 'Dummy Author',
        pages: 10,
        creationDate: new Date(),
      },
    };
  }

  async generatePdf(
    content: string | { html: string },
    options?: PdfGenerationOptions
  ): Promise<Buffer> {
    logger.debug('Generating PDF', JSON.stringify(options));

    // Return dummy PDF buffer
    const dummyPdf = Buffer.from('dummy-pdf-content');

    logger.debug(`Generated PDF: ${dummyPdf.length} bytes`);

    return dummyPdf;
  }

  async convertToPdf(
    input: Buffer,
    inputFormat: 'html' | 'markdown' | 'docx',
    options?: PdfConversionOptions
  ): Promise<Buffer> {
    logger.debug(`Converting ${inputFormat} to PDF`, JSON.stringify(options));

    // Return dummy PDF buffer
    const dummyPdf = Buffer.from(`dummy-pdf-from-${inputFormat}`);

    logger.debug(`Converted to PDF: ${dummyPdf.length} bytes`);

    return dummyPdf;
  }

  async mergePdfs(pdfBuffers: Buffer[]): Promise<Buffer> {
    logger.debug(`Merging ${pdfBuffers.length} PDFs`);

    // Return dummy merged PDF buffer
    const totalSize = pdfBuffers.reduce((sum, buf) => sum + buf.length, 0);
    const mergedPdf = Buffer.from(`dummy-merged-pdf-${totalSize}`);

    return mergedPdf;
  }

  async splitPdf(pdfBuffer: Buffer, ranges: Array<[number, number]>): Promise<Buffer[]> {
    logger.debug(`Splitting PDF into ${ranges.length} parts`);

    // Return dummy split PDF buffers
    return ranges.map((range, index) =>
      Buffer.from(`dummy-split-pdf-part-${index}-pages-${range[0]}-${range[1]}`)
    );
  }

  getDexName(): string {
    return 'dummy-pdf';
  }
}
