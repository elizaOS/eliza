/** Public text, geometry, page, and metadata contracts returned by PdfService. */

export interface PdfConversionResult {
  success: boolean;
  text?: string;
  pageCount?: number;
  error?: string;
}

export interface PdfExtractionOptions {
  startPage?: number;
  endPage?: number;
  preserveWhitespace?: boolean;
  cleanContent?: boolean;
}

export interface PdfPageInfo {
  pageNumber: number;
  width: number;
  height: number;
  text: string;
}

export interface PdfPositionedTextItem {
  page: number;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PdfPositionedTextDocument {
  pageCount: number;
  items: PdfPositionedTextItem[];
}

export interface PdfMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  creationDate?: Date;
  modificationDate?: Date;
}

export interface PdfDocumentInfo {
  pageCount: number;
  metadata: PdfMetadata;
  text: string;
  pages: PdfPageInfo[];
}
