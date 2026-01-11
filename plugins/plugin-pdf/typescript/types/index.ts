/**
 * PDF Plugin Types
 *
 * Strong types for PDF processing operations.
 */

/**
 * Result of a PDF conversion operation.
 */
export interface PdfConversionResult {
  /** Whether the conversion was successful */
  success: boolean;
  /** The extracted text content */
  text?: string;
  /** Number of pages in the PDF */
  pageCount?: number;
  /** Error message if unsuccessful */
  error?: string;
}

/**
 * Options for PDF text extraction.
 */
export interface PdfExtractionOptions {
  /** Starting page (1-indexed) */
  startPage?: number;
  /** Ending page (1-indexed) */
  endPage?: number;
  /** Whether to preserve whitespace */
  preserveWhitespace?: boolean;
  /** Whether to clean control characters */
  cleanContent?: boolean;
}

/**
 * PDF page information.
 */
export interface PdfPageInfo {
  /** Page number (1-indexed) */
  pageNumber: number;
  /** Page width in points */
  width: number;
  /** Page height in points */
  height: number;
  /** Text content of the page */
  text: string;
}

/**
 * PDF document metadata.
 */
export interface PdfMetadata {
  /** Document title */
  title?: string;
  /** Document author */
  author?: string;
  /** Document subject */
  subject?: string;
  /** Document keywords */
  keywords?: string;
  /** Document creator */
  creator?: string;
  /** Document producer */
  producer?: string;
  /** Creation date */
  creationDate?: Date;
  /** Modification date */
  modificationDate?: Date;
}

/**
 * Full PDF document information.
 */
export interface PdfDocumentInfo {
  /** Number of pages */
  pageCount: number;
  /** Document metadata */
  metadata: PdfMetadata;
  /** Full text content */
  text: string;
  /** Per-page information */
  pages: PdfPageInfo[];
}


