/**
 * Upload limits, accepted extensions, and pure file-classification helpers for
 * the Documents upload flow: request/bulk byte budgets, the supported-extension
 * set and its `accept` string, and predicates deciding whether a file is
 * supported and whether it should be read as text vs binary. Shared by the
 * upload UI and its tests.
 */

import type { DocumentScope } from "../../api/client-types-chat";

export const MAX_UPLOAD_REQUEST_BYTES = 32 * 1_048_576;
export const BULK_UPLOAD_TARGET_BYTES = 24 * 1_048_576;
export const MAX_BULK_REQUEST_DOCUMENTS = 100;
export const LARGE_FILE_WARNING_BYTES = 8 * 1_048_576;
export const SUPPORTED_UPLOAD_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".mdx",
  ".pdf",
  ".docx",
  ".json",
  ".csv",
  ".xml",
  ".html",
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
]);
export const DOCUMENT_UPLOAD_ACCEPT = Array.from(
  SUPPORTED_UPLOAD_EXTENSIONS,
).join(",");

export type DocumentUploadFile = File & {
  webkitRelativePath?: string;
};

export type DocumentUploadOptions = {
  includeImageDescriptions: boolean;
  scope: DocumentScope;
};

export const DEFAULT_DOCUMENT_UPLOAD_SCOPE: DocumentScope = "user-private";

export function getDocumentUploadFilename(file: DocumentUploadFile): string {
  return file.webkitRelativePath?.trim() || file.name;
}

export function shouldReadDocumentFileAsText(
  file: Pick<File, "type" | "name">,
): boolean {
  const textTypes = [
    "text/plain",
    "text/markdown",
    "text/html",
    "text/csv",
    "application/json",
    "application/xml",
  ];

  return (
    textTypes.some((t) => file.type.includes(t)) ||
    file.name.endsWith(".md") ||
    file.name.endsWith(".mdx")
  );
}

export function isSupportedDocumentFile(file: Pick<File, "name">): boolean {
  const lowerName = file.name.toLowerCase();
  for (const extension of SUPPORTED_UPLOAD_EXTENSIONS) {
    if (lowerName.endsWith(extension)) return true;
  }
  return false;
}
