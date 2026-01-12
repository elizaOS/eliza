import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
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

  if (
    lowerContentType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  ) {
    try {
      const result = await mammoth.extractRawText({ buffer: fileBuffer });
      return result.value;
    } catch (docxError) {
      const errorMessage = docxError instanceof Error ? docxError.message : String(docxError);
      throw new Error(`Failed to parse DOCX file ${originalFilename}: ${errorMessage}`);
    }
  } else if (
    lowerContentType === "application/msword" ||
    originalFilename.toLowerCase().endsWith(".doc")
  ) {
    return `[Microsoft Word Document: ${originalFilename}]\n\nThis document was indexed for search but cannot be displayed directly in the browser. The original document content is preserved for retrieval purposes.`;
  } else if (
    lowerContentType.startsWith("text/") ||
    PLAIN_TEXT_CONTENT_TYPES.includes(lowerContentType)
  ) {
    return fileBuffer.toString("utf-8");
  } else {
    if (fileBuffer.length > MAX_FALLBACK_SIZE_BYTES) {
      throw new Error(
        `File ${originalFilename} exceeds maximum size for fallback (${MAX_FALLBACK_SIZE_BYTES} bytes)`
      );
    }

    const initialBytes = fileBuffer.subarray(0, Math.min(fileBuffer.length, BINARY_CHECK_BYTES));
    if (initialBytes.includes(0)) {
      throw new Error(`File ${originalFilename} appears to be binary based on initial byte check`);
    }

    try {
      const textContent = fileBuffer.toString("utf-8");
      if (textContent.includes("\ufffd")) {
        throw new Error(
          `File ${originalFilename} seems to be binary or has encoding issues (detected \ufffd)`
        );
      }
      return textContent;
    } catch (_fallbackError) {
      throw new Error(
        `Unsupported content type: ${contentType} for ${originalFilename}. Fallback to plain text failed`
      );
    }
  }
}

export async function convertPdfToTextFromBuffer(
  pdfBuffer: Buffer,
  _filename?: string
): Promise<string> {
  try {
    const uint8Array = new Uint8Array(
      pdfBuffer.buffer.slice(pdfBuffer.byteOffset, pdfBuffer.byteOffset + pdfBuffer.byteLength)
    );

    const result = await extractText(uint8Array, {
      mergePages: true,
    });

    if (!result.text || result.text.trim().length === 0) {
      return "";
    }

    const cleanedText = result.text
      .split("\n")
      .map((line: string) => line.trim())
      .filter((line: string) => line.length > 0)
      .join("\n")
      .replace(/\n{3,}/g, "\n\n");

    return cleanedText;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
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
  } catch {
    return url;
  }
}

export async function fetchUrlContent(
  url: string
): Promise<{ content: string; contentType: string }> {
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
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const base64Content = buffer.toString("base64");

    return {
      content: base64Content,
      contentType,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
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

  return uuidv5(hash, DOCUMENT_NAMESPACE);
}

export function extractFirstLines(content: string, maxLines: number = 10): string {
  const lines = content.split(/\r?\n/);
  return lines.slice(0, maxLines).join("\n");
}
