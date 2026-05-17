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
