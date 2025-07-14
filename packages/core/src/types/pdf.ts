import { Service, ServiceType } from './service';

export interface PdfExtractionResult {
  text: string;
  pageCount: number;
  metadata?: {
    title?: string;
    author?: string;
    createdAt?: Date;
    modifiedAt?: Date;
  };
}

export interface PdfGenerationOptions {
  format?: 'A4' | 'A3' | 'Letter';
  orientation?: 'portrait' | 'landscape';
  margins?: {
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
  };
  header?: string;
  footer?: string;
}

export interface PdfConversionOptions {
  quality?: 'high' | 'medium' | 'low';
  outputFormat?: 'pdf' | 'pdf/a';
  compression?: boolean;
}

/**
 * Interface for PDF processing services
 */
export abstract class IPdfService extends Service {
  static override readonly serviceType = ServiceType.PDF;

  public readonly capabilityDescription = 'PDF processing, extraction, and generation capabilities';

  /**
   * Extract text and metadata from a PDF file
   * @param pdfPath - Path to the PDF file or buffer
   * @returns Promise resolving to extracted text and metadata
   */
  abstract extractText(pdfPath: string | Buffer): Promise<PdfExtractionResult>;

  /**
   * Generate a PDF from HTML content
   * @param htmlContent - HTML content to convert to PDF
   * @param options - PDF generation options
   * @returns Promise resolving to PDF buffer
   */
  abstract generatePdf(htmlContent: string, options?: PdfGenerationOptions): Promise<Buffer>;

  /**
   * Convert a document to PDF format
   * @param filePath - Path to the document file
   * @param options - Conversion options
   * @returns Promise resolving to PDF buffer
   */
  abstract convertToPdf(filePath: string, options?: PdfConversionOptions): Promise<Buffer>;

  /**
   * Merge multiple PDF files into one
   * @param pdfPaths - Array of PDF file paths or buffers
   * @returns Promise resolving to merged PDF buffer
   */
  abstract mergePdfs(pdfPaths: (string | Buffer)[]): Promise<Buffer>;

  /**
   * Split a PDF into individual pages
   * @param pdfPath - Path to the PDF file or buffer
   * @returns Promise resolving to array of page buffers
   */
  abstract splitPdf(pdfPath: string | Buffer): Promise<Buffer[]>;
}
