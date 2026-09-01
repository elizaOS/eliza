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

export type PdfCompletePageMethod = "native" | "native+vision" | "vision" | "blank";

/** Lossless page result used when every PDF page must be accounted for. */
export interface PdfCompletePage {
  pageNumber: number;
  width: number;
  height: number;
  method: PdfCompletePageMethod;
  nativeText: string;
  /** Native PDF text items whose geometry was valid, retained as parser evidence. */
  nativePositionedText: PdfPositionedTextItem[];
  ocrText: string | null;
  visionText: string | null;
  text: string;
  hasVisualContent: boolean;
}

/** Complete only after all parser-declared pages have succeeded or are verified blank. */
export interface PdfCompleteDocument {
  complete: true;
  pageCount: number;
  pages: PdfCompletePage[];
  text: string;
}

export interface PdfCompleteExtractionOptions {
  /** Called after each page reaches a terminal successful state. */
  onPageComplete?: (page: PdfCompletePage) => void | Promise<void>;
  /** Optional extra context appended to the strict transcription prompt. */
  visionPrompt?: string;
  /** Render scale used for page-level OCR/vision. Defaults to 2. */
  renderScale?: number;
  /** Optional platform OCR seam; vision transcription remains the fallback. */
  ocrPage?: (input: { pageNumber: number; pngBytes: Uint8Array }) => Promise<string>;
}
