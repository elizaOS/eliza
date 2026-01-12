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

const MAX_FALLBACK_SIZE_BYTES = 5 * 1024 * 1024;
const BINARY_CHECK_BYTES = 1024;

export async function extractTextFromFileBuffer(
  fileBuffer: Buffer,
  contentType: string,
  originalFilename: string
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
    logger.debug(`[TextUtil] Handling Microsoft Word .doc file: ${originalFilename}`);

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

    const initialBytes = fileBuffer.subarray(0, Math.min(fileBuffer.length, BINARY_CHECK_BYTES));
    if (initialBytes.includes(0)) {
      const binaryHeuristicMsg = `[TextUtil] File ${originalFilename} (type: ${contentType}) appears to be binary based on initial byte check. Cannot process as plain text.`;
      logger.error(binaryHeuristicMsg);
      throw new Error(binaryHeuristicMsg);
    }

    try {
      const textContent = fileBuffer.toString("utf-8");
      if (textContent.includes("\ufffd")) {
        const binaryErrorMsg = `[TextUtil] File ${originalFilename} (type: ${contentType}) seems to be binary or has encoding issues after fallback to plain text (detected \ufffd).`;
        logger.error(binaryErrorMsg);
        throw new Error(binaryErrorMsg);
      }
      logger.debug(
        `[TextUtil] Successfully processed unknown type ${contentType} as plain text after fallback for ${originalFilename}.`
      );
      return textContent;
    } catch (fallbackError) {
      const finalErrorMsg = `[TextUtil] Unsupported content type: ${contentType} for ${originalFilename}. Fallback to plain text also failed or indicated binary content.`;
      const errorStack = fallbackError instanceof Error ? fallbackError.stack : undefined;
      logger.error(finalErrorMsg, errorStack);
      throw new Error(finalErrorMsg);
    }
  }
}

export async function convertPdfToTextFromBuffer(
  pdfBuffer: Buffer,
  filename?: string
): Promise<string> {
  const docName = filename || "unnamed-document";
  logger.debug(`[PdfService] Starting conversion for ${docName} using unpdf`);

  try {
    const uint8Array = new Uint8Array(
      pdfBuffer.buffer.slice(pdfBuffer.byteOffset, pdfBuffer.byteOffset + pdfBuffer.byteLength)
    );

    const result = await extractText(uint8Array, {
      mergePages: true,
    });

    if (!result.text || result.text.trim().length === 0) {
      logger.warn(`[PdfService] No text extracted from ${docName}`);
      return "";
    }

    const cleanedText = result.text
      .split("\n")
      .map((line: string) => line.trim())
      .filter((line: string) => line.length > 0)
      .join("\n")
      .replace(/\n{3,}/g, "\n\n");

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

export function isBinaryContentType(contentType: string, filename: string): boolean {
  const textContentTypes = [
    "text/",
    "application/json",
    "application/xml",
    "application/javascript",
    "application/typescript",
    "application/x-yaml",
    "application/x-sh",
  ];

  const isTextMimeType = textContentTypes.some((type) => contentType.includes(type));
  if (isTextMimeType) {
    return false;
  }

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

  const isBinaryMimeType = binaryContentTypes.some((type) => contentType.includes(type));

  if (isBinaryMimeType) {
    return true;
  }

  const fileExt = filename.split(".").pop()?.toLowerCase() || "";

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

  if (textExtensions.includes(fileExt)) {
    return false;
  }

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

export function normalizeS3Url(url: string): string {
  try {
    const urlObj = new URL(url);
    return `${urlObj.origin}${urlObj.pathname}`;
  } catch (_error) {
    logger.warn(`[URL NORMALIZER] Failed to parse URL: ${url}. Returning original.`);
    return url;
  }
}

export async function fetchUrlContent(
  url: string
): Promise<{ content: string; contentType: string }> {
  logger.debug(`[URL FETCHER] Fetching content from URL: ${url}`);

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

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

    const contentType = response.headers.get("content-type") || "application/octet-stream";
    logger.debug(`[URL FETCHER] Content type from server: ${contentType} for URL: ${url}`);

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

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

  if (cleanContent.length < 16) return false;

  if (cleanContent.length % 4 !== 0) return false;

  const base64Regex = /^[A-Za-z0-9+/]*={0,2}$/;
  if (!base64Regex.test(cleanContent)) return false;

  const hasNumbers = /\d/.test(cleanContent);
  const hasUpperCase = /[A-Z]/.test(cleanContent);
  const hasLowerCase = /[a-z]/.test(cleanContent);

  return (hasNumbers || hasUpperCase) && hasLowerCase;
}

export function generateContentBasedId(
  content: string,
  agentId: string,
  options?: {
    maxChars?: number;
    includeFilename?: string;
    contentType?: string;
  }
): string {
  const { maxChars = 2000, includeFilename, contentType } = options || {};

  let contentForHashing: string;

  if (looksLikeBase64(content)) {
    try {
      const decoded = Buffer.from(content, "base64").toString("utf8");
      if (!decoded.includes("\ufffd") || contentType?.includes("pdf")) {
        contentForHashing = content.slice(0, maxChars);
      } else {
        contentForHashing = decoded.slice(0, maxChars);
      }
    } catch {
      contentForHashing = content.slice(0, maxChars);
    }
  } else {
    contentForHashing = content.slice(0, maxChars);
  }

  contentForHashing = contentForHashing
    .replace(/\r\n/g, "\n") // Normalize line endings
    .replace(/\r/g, "\n")
    .trim();

  const componentsToHash = [agentId, contentForHashing, includeFilename || ""]
    .filter(Boolean)
    .join("::");

  const hash = createHash("sha256").update(componentsToHash).digest("hex");

  const DOCUMENT_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

  const uuid = uuidv5(hash, DOCUMENT_NAMESPACE);

  logger.debug(
    `[generateContentBasedId] Generated UUID ${uuid} for document with content hash ${hash.slice(0, 8)}...`
  );

  return uuid;
}

export function extractFirstLines(content: string, maxLines: number = 10): string {
  const lines = content.split(/\r?\n/);
  return lines.slice(0, maxLines).join("\n");
}
