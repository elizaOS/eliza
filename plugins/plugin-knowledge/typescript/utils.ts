import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { logger } from "@elizaos/core";
import * as mammoth from "mammoth";
import { extractText } from "unpdf";
import { v5 as uuidv5 } from "uuid";

const PLAIN_TEXT_CONTENT_TYPES = [
  "application/typescript",
  "text/typescript",
  "text/x-python",
  "application/x-python-code",
  "application/yaml",
  "text/yaml",
  "application/x-yaml",
  "application/json",
  "text/markdown",
  "text/csv",
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
    lowerContentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    logger.debug(`[TextUtil] Extracting text from DOCX ${originalFilename} via mammoth.`);
    try {
      const result = await mammoth.extractRawText({ buffer: fileBuffer });
      logger.debug(
        `[TextUtil] DOCX text extraction complete for ${originalFilename}. Text length: ${result.value.length}`
      );
      return result.value;
    } catch (docxError) {
      const errorMessage = docxError instanceof Error ? docxError.message : String(docxError);
      const errorStack = docxError instanceof Error ? docxError.stack : undefined;
      const errorMsg = `[TextUtil] Failed to parse DOCX file ${originalFilename}: ${errorMessage}`;
      logger.error(errorMsg, errorStack);
      throw new Error(errorMsg);
    }
  } else if (
    lowerContentType === "application/msword" ||
    originalFilename.toLowerCase().endsWith(".doc")
  ) {
    // For .doc files, we'll store the content as-is, and just add a message
    // The frontend will handle the display appropriately
    logger.debug(`[TextUtil] Handling Microsoft Word .doc file: ${originalFilename}`);

    // We'll add a descriptive message as a placeholder
    return `[Microsoft Word Document: ${originalFilename}]\n\nThis document was indexed for search but cannot be displayed directly in the browser. The original document content is preserved for retrieval purposes.`;
  } else if (
    lowerContentType.startsWith("text/") ||
    PLAIN_TEXT_CONTENT_TYPES.includes(lowerContentType)
  ) {
    logger.debug(
      `[TextUtil] Extracting text from plain text compatible file ${originalFilename} (type: ${contentType})`
    );
    return fileBuffer.toString("utf-8");
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
      const textContent = fileBuffer.toString("utf-8");
      if (textContent.includes("\ufffd")) {
        // Replacement character, indicating potential binary or wrong encoding
        const binaryErrorMsg = `[TextUtil] File ${originalFilename} (type: ${contentType}) seems to be binary or has encoding issues after fallback to plain text (detected \ufffd).`;
        logger.error(binaryErrorMsg);
        throw new Error(binaryErrorMsg); // Throw error for likely binary content
      }
      logger.debug(
        `[TextUtil] Successfully processed unknown type ${contentType} as plain text after fallback for ${originalFilename}.`
      );
      return textContent;
    } catch (fallbackError) {
      // If the initial toString failed or if we threw due to \ufffd
      const finalErrorMsg = `[TextUtil] Unsupported content type: ${contentType} for ${originalFilename}. Fallback to plain text also failed or indicated binary content.`;
      const errorStack = fallbackError instanceof Error ? fallbackError.stack : undefined;
      logger.error(finalErrorMsg, errorStack);
      throw new Error(finalErrorMsg);
    }
  }
}

/**
 * Converts a PDF Buffer to text using unpdf (universal PDF parser).
 * Works in Node.js, Bun, Browser, Edge, and Serverless environments.
 *
 * @param {Buffer} pdfBuffer - The PDF Buffer to convert to text
 * @param {string} [filename] - Optional filename for logging purposes
 * @returns {Promise<string>} Text content of the PDF
 */
export async function convertPdfToTextFromBuffer(
  pdfBuffer: Buffer,
  filename?: string
): Promise<string> {
  const docName = filename || "unnamed-document";
  logger.debug(`[PdfService] Starting conversion for ${docName} using unpdf`);

  try {
    // unpdf requires Uint8Array - convert Buffer properly
    // Buffer.from() returns a Buffer, but we need a pure Uint8Array
    const uint8Array = new Uint8Array(
      pdfBuffer.buffer.slice(pdfBuffer.byteOffset, pdfBuffer.byteOffset + pdfBuffer.byteLength)
    );

    const result = await extractText(uint8Array, {
      mergePages: true, // Merge all pages into a single string
    });

    if (!result.text || result.text.trim().length === 0) {
      logger.warn(`[PdfService] No text extracted from ${docName}`);
      return "";
    }

    // Clean up excessive whitespace while preserving paragraph structure
    const cleanedText = result.text
      .split("\n")
      .map((line: string) => line.trim())
      .filter((line: string) => line.length > 0)
      .join("\n")
      .replace(/\n{3,}/g, "\n\n"); // Max 2 consecutive newlines

    logger.debug(
      `[PdfService] Conversion complete for ${docName}, ${result.totalPages} pages, length: ${cleanedText.length}`
    );
    return cleanedText;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[PdfService] Error converting PDF ${docName}:`, errorMessage);
    throw new Error(`Failed to convert PDF to text: ${errorMessage}`);
  }
}

/**
 * Determines if a file should be treated as binary based on its content type and filename
 * @param contentType MIME type of the file
 * @param filename Original filename
 * @returns True if the file should be treated as binary (base64 encoded)
 */
export function isBinaryContentType(contentType: string, filename: string): boolean {
  // Text-based content types that should NOT be treated as binary
  const textContentTypes = [
    "text/",
    "application/json",
    "application/xml",
    "application/javascript",
    "application/typescript",
    "application/x-yaml",
    "application/x-sh",
  ];

  // Check if it's a text-based MIME type
  const isTextMimeType = textContentTypes.some((type) => contentType.includes(type));
  if (isTextMimeType) {
    return false;
  }

  // Binary content types
  const binaryContentTypes = [
    "application/pdf",
    "application/msword",
    "application/vnd.openxmlformats-officedocument",
    "application/vnd.ms-excel",
    "application/vnd.ms-powerpoint",
    "application/zip",
    "application/x-zip-compressed",
    "application/octet-stream",
    "image/",
    "audio/",
    "video/",
  ];

  // Check MIME type
  const isBinaryMimeType = binaryContentTypes.some((type) => contentType.includes(type));

  if (isBinaryMimeType) {
    return true;
  }

  // Check file extension as fallback
  const fileExt = filename.split(".").pop()?.toLowerCase() || "";

  // Text file extensions that should NOT be treated as binary
  const textExtensions = [
    "txt",
    "md",
    "markdown",
    "json",
    "xml",
    "html",
    "htm",
    "css",
    "js",
    "ts",
    "jsx",
    "tsx",
    "yaml",
    "yml",
    "toml",
    "ini",
    "cfg",
    "conf",
    "sh",
    "bash",
    "zsh",
    "fish",
    "py",
    "rb",
    "go",
    "rs",
    "java",
    "c",
    "cpp",
    "h",
    "hpp",
    "cs",
    "php",
    "sql",
    "r",
    "swift",
    "kt",
    "scala",
    "clj",
    "ex",
    "exs",
    "vim",
    "env",
    "gitignore",
    "dockerignore",
    "editorconfig",
    "log",
    "csv",
    "tsv",
    "properties",
    "gradle",
    "sbt",
    "makefile",
    "dockerfile",
    "vagrantfile",
    "gemfile",
    "rakefile",
    "podfile",
    "csproj",
    "vbproj",
    "fsproj",
    "sln",
    "pom",
  ];

  // If it's a known text extension, it's not binary
  if (textExtensions.includes(fileExt)) {
    return false;
  }

  // Binary file extensions
  const binaryExtensions = [
    "pdf",
    "docx",
    "doc",
    "xls",
    "xlsx",
    "ppt",
    "pptx",
    "zip",
    "rar",
    "7z",
    "tar",
    "gz",
    "bz2",
    "xz",
    "jpg",
    "jpeg",
    "png",
    "gif",
    "bmp",
    "svg",
    "ico",
    "webp",
    "mp3",
    "mp4",
    "avi",
    "mov",
    "wmv",
    "flv",
    "wav",
    "flac",
    "ogg",
    "exe",
    "dll",
    "so",
    "dylib",
    "bin",
    "dat",
    "db",
    "sqlite",
  ];

  return binaryExtensions.includes(fileExt);
}

/**
 * Normalizes an S3 URL by removing query parameters (signature, etc.)
 * This allows for consistent URL comparison regardless of presigned URL parameters
 * @param url The S3 URL to normalize
 * @returns The normalized URL containing only the origin and pathname
 */
export function normalizeS3Url(url: string): string {
  try {
    const urlObj = new URL(url);
    return `${urlObj.origin}${urlObj.pathname}`;
  } catch (_error) {
    logger.warn(`[URL NORMALIZER] Failed to parse URL: ${url}. Returning original.`);
    return url;
  }
}

/**
 * Fetches content from a URL and converts it to base64 format
 * @param url The URL to fetch content from
 * @returns An object containing the base64 content and content type
 */
export async function fetchUrlContent(
  url: string
): Promise<{ content: string; contentType: string }> {
  logger.debug(`[URL FETCHER] Fetching content from URL: ${url}`);

  try {
    // Fetch the URL with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000); // 30 second timeout

    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Eliza-Knowledge-Plugin/1.0",
      },
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Failed to fetch URL: ${response.status} ${response.statusText}`);
    }

    // Get content type from response headers
    const contentType = response.headers.get("content-type") || "application/octet-stream";
    logger.debug(`[URL FETCHER] Content type from server: ${contentType} for URL: ${url}`);

    // Get content as ArrayBuffer
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    // Convert to base64
    const base64Content = buffer.toString("base64");

    logger.debug(
      `[URL FETCHER] Successfully fetched content from URL: ${url} (${buffer.length} bytes)`
    );
    return {
      content: base64Content,
      contentType,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    logger.error(`[URL FETCHER] Error fetching content from URL ${url}: ${errorMessage}`);
    throw new Error(`Failed to fetch content from URL: ${errorMessage}`);
  }
}

export function looksLikeBase64(content?: string | null): boolean {
  if (!content || content.length === 0) return false;

  const cleanContent = content.replace(/\s/g, "");

  // Too short to be meaningful Base64
  if (cleanContent.length < 16) return false;

  // Must be divisible by 4
  if (cleanContent.length % 4 !== 0) return false;

  // Check for Base64 pattern with proper padding
  const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
  if (!base64Regex.test(cleanContent)) return false;

  // Additional heuristic: Base64 typically has a good mix of characters
  const hasNumbers = /\d/.test(cleanContent);
  const hasUpperCase = /[A-Z]/.test(cleanContent);
  const hasLowerCase = /[a-z]/.test(cleanContent);

  return (hasNumbers || hasUpperCase) && hasLowerCase;
}

/**
 * Generates a consistent UUID for a document based on its content.
 * Takes the first N characters/lines of the document and creates a hash-based UUID.
 * This ensures the same document always gets the same ID, preventing duplicates.
 *
 * @param content The document content (text or base64)
 * @param agentId The agent ID to namespace the document
 * @param options Optional configuration for ID generation
 * @returns A deterministic UUID based on the content
 */
export function generateContentBasedId(
  content: string,
  agentId: string,
  options?: {
    maxChars?: number;
    includeFilename?: string;
    contentType?: string;
  }
): string {
  const {
    maxChars = 2000, // Use first 2000 chars by default
    includeFilename,
    contentType,
  } = options || {};

  // For consistent hashing, we need to normalize the content
  let contentForHashing: string;

  // If it's base64, decode it first to get actual content
  if (looksLikeBase64(content)) {
    try {
      const decoded = Buffer.from(content, "base64").toString("utf8");
      // Check if decoded content is readable text
      if (!decoded.includes("\ufffd") || contentType?.includes("pdf")) {
        // For PDFs and other binary files, use a portion of the base64 itself
        contentForHashing = content.slice(0, maxChars);
      } else {
        // For text files that were base64 encoded, use the decoded text
        contentForHashing = decoded.slice(0, maxChars);
      }
    } catch {
      // If decoding fails, use the base64 string itself
      contentForHashing = content.slice(0, maxChars);
    }
  } else {
    // Plain text content
    contentForHashing = content.slice(0, maxChars);
  }

  // Normalize whitespace and line endings for consistency
  contentForHashing = contentForHashing
    .replace(/\r\n/g, "\n") // Normalize line endings
    .replace(/\r/g, "\n")
    .trim();

  // Create a deterministic string that includes all relevant factors
  const componentsToHash = [
    agentId, // Namespace by agent
    contentForHashing, // The actual content
    includeFilename || "", // Optional filename for additional uniqueness
  ]
    .filter(Boolean)
    .join("::");

  // Create SHA-256 hash
  const hash = createHash("sha256").update(componentsToHash).digest("hex");

  // Use a namespace UUID for documents (you can define this as a constant)
  const DOCUMENT_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8"; // Standard namespace UUID

  // Generate UUID v5 from the hash (deterministic)
  const uuid = uuidv5(hash, DOCUMENT_NAMESPACE);

  logger.debug(
    `[generateContentBasedId] Generated UUID ${uuid} for document with content hash ${hash.slice(0, 8)}...`
  );

  return uuid;
}

/**
 * Extracts the first N lines from text content for ID generation
 * @param content The full text content
 * @param maxLines Maximum number of lines to extract
 * @returns The extracted lines as a single string
 */
export function extractFirstLines(content: string, maxLines: number = 10): string {
  const lines = content.split(/\r?\n/);
  return lines.slice(0, maxLines).join("\n");
}
