import { Buffer } from 'node:buffer';
import * as mammoth from 'mammoth';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { logger } from '@elizaos/core';

// It's crucial that pdf.worker.mjs is accessible.
// pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.mjs'; // This line is usually set closer to the execution context (e.g., in the worker itself or main thread init)

const PLAIN_TEXT_CONTENT_TYPES = [
  'application/typescript',
  'text/typescript',
  'text/x-python',
  'application/x-python-code',
  'application/yaml',
  'text/yaml',
  'application/x-yaml',
  'application/json',
  'text/markdown',
  'text/csv',
];

const MAX_FALLBACK_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
const BINARY_CHECK_BYTES = 1024; // Check first 1KB for binary indicators

/**
 * Extracts text content from a file buffer based on its content type.
 * Supports DOCX, plain text, and provides a fallback for unknown types.
 * PDF should be handled by `convertPdfToTextFromBuffer`.
 */
export async function extractTextFromFileBuffer(
  fileBuffer: Buffer,
  contentType: string,
  originalFilename: string // For logging and context
): Promise<string> {
  const lowerContentType = contentType.toLowerCase();
  logger.debug(
    `[TextUtil] Attempting to extract text from ${originalFilename} (type: ${contentType})`
  );

  if (
    lowerContentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ) {
    logger.debug(`[TextUtil] Extracting text from DOCX ${originalFilename} via mammoth.`);
    try {
      const result = await mammoth.extractRawText({ buffer: fileBuffer });
      logger.debug(
        `[TextUtil] DOCX text extraction complete for ${originalFilename}. Text length: ${result.value.length}`
      );
      return result.value;
    } catch (docxError: any) {
      const errorMsg = `[TextUtil] Failed to parse DOCX file ${originalFilename}: ${docxError.message}`;
      logger.error(errorMsg, docxError.stack);
      throw new Error(errorMsg);
    }
  } else if (
    lowerContentType.startsWith('text/') ||
    PLAIN_TEXT_CONTENT_TYPES.includes(lowerContentType)
  ) {
    logger.debug(
      `[TextUtil] Extracting text from plain text compatible file ${originalFilename} (type: ${contentType})`
    );
    return fileBuffer.toString('utf-8');
  } else {
    logger.warn(
      `[TextUtil] Unsupported content type: "${contentType}" for ${originalFilename}. Attempting fallback to plain text.`
    );

    if (fileBuffer.length > MAX_FALLBACK_SIZE_BYTES) {
      const sizeErrorMsg = `[TextUtil] File ${originalFilename} (type: ${contentType}) exceeds maximum size for fallback (${MAX_FALLBACK_SIZE_BYTES} bytes). Cannot process as plain text.`;
      logger.error(sizeErrorMsg);
      throw new Error(sizeErrorMsg);
    }

    // Simple binary detection: check for null bytes in the first N bytes
    const initialBytes = fileBuffer.subarray(0, Math.min(fileBuffer.length, BINARY_CHECK_BYTES));
    if (initialBytes.includes(0)) {
      // Check for NUL byte
      const binaryHeuristicMsg = `[TextUtil] File ${originalFilename} (type: ${contentType}) appears to be binary based on initial byte check. Cannot process as plain text.`;
      logger.error(binaryHeuristicMsg);
      throw new Error(binaryHeuristicMsg);
    }

    try {
      const textContent = fileBuffer.toString('utf-8');
      if (textContent.includes('\ufffd')) {
        // Replacement character, indicating potential binary or wrong encoding
        const binaryErrorMsg = `[TextUtil] File ${originalFilename} (type: ${contentType}) seems to be binary or has encoding issues after fallback to plain text (detected \ufffd).`;
        logger.error(binaryErrorMsg);
        throw new Error(binaryErrorMsg); // Throw error for likely binary content
      }
      logger.debug(
        `[TextUtil] Successfully processed unknown type ${contentType} as plain text after fallback for ${originalFilename}.`
      );
      return textContent;
    } catch (fallbackError: any) {
      // If the initial toString failed or if we threw due to \ufffd
      const finalErrorMsg = `[TextUtil] Unsupported content type: ${contentType} for ${originalFilename}. Fallback to plain text also failed or indicated binary content.`;
      logger.error(finalErrorMsg, fallbackError.message ? fallbackError.stack : undefined);
      throw new Error(finalErrorMsg);
    }
  }
}

/**
 * Converts a PDF file buffer to text content.
 * Requires pdfjs-dist to be properly configured, especially its worker.
 */
export async function convertPdfToTextFromBuffer(
  pdfBuffer: Buffer,
  pdfFilename: string
): Promise<string> {
  logger.debug(`[PDFUtil] Starting PDF to text conversion for ${pdfFilename}.`);
  try {
    // Ensure GlobalWorkerOptions.workerSrc is set appropriately in the environment calling this function.
    // Example: pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.mjs'; (if in dist folder relative to execution)
    const uint8ArrayBuffer = new Uint8Array(pdfBuffer);
    const loadingTask = pdfjsLib.getDocument({ data: uint8ArrayBuffer });
    const pdfDocument = await loadingTask.promise;
    const allPagesText: string[] = [];

    for (let i = 1; i <= pdfDocument.numPages; i++) {
      const page = await pdfDocument.getPage(i);
      const textContent = await page.getTextContent();
      const pageText = textContent.items
        .filter((item: any) => typeof item.str === 'string' && item.str.trim() !== '')
        .map((item: any) => item.str as string)
        .join(' ');
      if (pageText.length > 0) {
        allPagesText.push(pageText);
      }
    }
    const fullText = allPagesText.join('\n').trim();
    logger.debug(
      `[PDFUtil] PDF to text conversion complete for ${pdfFilename}. Text length: ${fullText.length}`
    );
    return fullText;
  } catch (error: any) {
    // Catching as any to access error.message and error.stack
    logger.error(`[PDFUtil] Error parsing PDF ${pdfFilename}:`, error.message, error.stack);
    throw new Error(`Failed to convert PDF ${pdfFilename} to text.`);
  }
}
