import { IAgentRuntime } from '@elizaos/core';
import {
  IPdfService,
  PdfExtractionResult,
  PdfGenerationOptions,
  PdfConversionOptions,
} from '@elizaos/core';

/**
 * Dummy PDF service for testing purposes
 * Provides mock implementations of PDF processing operations
 */
export class DummyPdfService extends IPdfService {
  static override readonly serviceType = IPdfService.serviceType;

  constructor(runtime: IAgentRuntime) {
    super(runtime);
  }

  static async start(runtime: IAgentRuntime): Promise<DummyPdfService> {
    const service = new DummyPdfService(runtime);
    await service.initialize();
    return service;
  }

  async initialize(): Promise<void> {
    this.runtime.logger.info('DummyPdfService initialized');
  }

  async stop(): Promise<void> {
    this.runtime.logger.info('DummyPdfService stopped');
  }

  async extractText(pdfPath: string | Buffer): Promise<PdfExtractionResult> {
    const isBuffer = Buffer.isBuffer(pdfPath);
    const filename = isBuffer ? 'buffer.pdf' : pdfPath;

    this.runtime.logger.debug(`Extracting text from ${filename}`);

    // Mock extraction result
    return {
      text: `Mock extracted text from ${filename}.\n\nThis is a dummy PDF service that simulates text extraction.\n\nPage 1: Lorem ipsum dolor sit amet, consectetur adipiscing elit.\nPage 2: Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.\nPage 3: Ut enim ad minim veniam, quis nostrud exercitation ullamco.`,
      pageCount: 3,
      metadata: {
        title: 'Mock PDF Document',
        author: 'Dummy Service',
        createdAt: new Date('2024-01-01'),
        modifiedAt: new Date(),
      },
    };
  }

  async generatePdf(htmlContent: string, options?: PdfGenerationOptions): Promise<Buffer> {
    this.runtime.logger.debug('Generating PDF from HTML content');

    // Mock PDF generation
    const pdfContent = `Mock PDF generated from HTML content with ${htmlContent.length} characters`;
    const mockPdfBuffer = Buffer.from(pdfContent, 'utf8');

    // Simulate processing options
    if (options) {
      this.runtime.logger.debug('PDF generation options:', options);
    }

    return mockPdfBuffer;
  }

  async convertToPdf(filePath: string, options?: PdfConversionOptions): Promise<Buffer> {
    this.runtime.logger.debug(`Converting ${filePath} to PDF`);

    // Mock PDF conversion
    const pdfContent = `Mock PDF converted from ${filePath}`;
    const mockPdfBuffer = Buffer.from(pdfContent, 'utf8');

    // Simulate processing options
    if (options) {
      this.runtime.logger.debug('PDF conversion options:', options);
    }

    return mockPdfBuffer;
  }

  async mergePdfs(pdfPaths: (string | Buffer)[]): Promise<Buffer> {
    this.runtime.logger.debug(`Merging ${pdfPaths.length} PDF files`);

    // Mock PDF merging
    const mergedContent = pdfPaths
      .map((path, index) => {
        const name = Buffer.isBuffer(path) ? `buffer-${index}` : path;
        return `Content from ${name}`;
      })
      .join('\n\n');

    const mockMergedBuffer = Buffer.from(`Mock merged PDF:\n${mergedContent}`, 'utf8');
    return mockMergedBuffer;
  }

  async splitPdf(pdfPath: string | Buffer): Promise<Buffer[]> {
    this.runtime.logger.debug('Splitting PDF into pages');

    const filename = Buffer.isBuffer(pdfPath) ? 'buffer.pdf' : pdfPath;

    // Mock PDF splitting - return 3 pages
    const pages = [
      Buffer.from(`Mock Page 1 from ${filename}`, 'utf8'),
      Buffer.from(`Mock Page 2 from ${filename}`, 'utf8'),
      Buffer.from(`Mock Page 3 from ${filename}`, 'utf8'),
    ];

    return pages;
  }
}
