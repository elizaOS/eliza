import type { Memory } from "@elizaos/core";
import type { DocumentVisibilityScope } from "./service-loader.js";

export type DocumentProvenanceKind =
  | "upload"
  | "learned"
  | "character"
  | "url"
  | "youtube"
  | "bundled"
  | "unknown";

export interface DocumentProvenance {
  kind: DocumentProvenanceKind;
  label: string;
  detail?: string;
}

export interface PresentedDocument {
  id: string;
  filename: string;
  contentType: string;
  fileSize: number;
  createdAt: number;
  fragmentCount: number;
  source: DocumentProvenanceKind;
  scope: DocumentVisibilityScope;
  scopedToEntityId?: string;
  addedBy?: string;
  addedByRole?: string;
  addedFrom?: string;
  url?: string;
  provenance: DocumentProvenance;
  canEditText: boolean;
  editabilityReason?: string;
  canDelete: boolean;
  deleteabilityReason?: string;
  content?: { text?: string };
}

const BINARY_CONTENT_TYPE_PREFIXES = [
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/octet-stream",
  "image/",
  "audio/",
  "video/",
];

const BINARY_FILE_EXTENSIONS = new Set([
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "zip",
  "rar",
  "7z",
  "jpg",
  "jpeg",
  "png",
  "gif",
  "bmp",
  "svg",
  "webp",
  "mp3",
  "wav",
  "mp4",
  "mov",
  "avi",
]);

const DOCUMENT_SCOPE_VALUES = new Set<DocumentVisibilityScope>([
  "global",
  "owner-private",
  "user-private",
  "agent-private",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function truncateLabel(value: string, maxLength = 80): string {
  return value.length > maxLength
    ? `${value.slice(0, maxLength - 1).trimEnd()}...`
    : value;
}

function stripMarkdownPrefix(line: string): string {
  return line
    .replace(/^#+\s*/, "")
    .replace(/^[-*]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .trim();
}

function deriveTitleFromText(
  text: string | undefined,
  fallback = "Untitled",
): string {
  if (!text) return fallback;

  const lines = text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    if (/^path:\s+/i.test(line)) continue;
    const candidate = stripMarkdownPrefix(line);
    if (candidate.length > 0) {
      return truncateLabel(candidate);
    }
  }

  return fallback;
}

function looksLikeBase64(text: string): boolean {
  const clean = text.replace(/\s/g, "");
  if (clean.length < 16 || clean.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return false;
  return /[a-z]/.test(clean) && (/[A-Z]/.test(clean) || /\d/.test(clean));
}

function getFilenameExtension(
  filename: string | undefined,
): string | undefined {
  if (!filename) return undefined;
  const dotIndex = filename.lastIndexOf(".");
  if (dotIndex <= 0 || dotIndex === filename.length - 1) return undefined;
  return filename.slice(dotIndex + 1).toLowerCase();
}

function isBinaryLike(
  contentType: string | undefined,
  filename: string | undefined,
) {
  const normalizedContentType = contentType?.toLowerCase();
  if (
    normalizedContentType &&
    BINARY_CONTENT_TYPE_PREFIXES.some((prefix) =>
      normalizedContentType.startsWith(prefix),
    )
  ) {
    return true;
  }

  const extension = getFilenameExtension(filename);
  return extension ? BINARY_FILE_EXTENSIONS.has(extension) : false;
}

function isGenericFilename(
  filename: string | undefined,
  provenanceKind: DocumentProvenanceKind,
): boolean {
  if (!filename) return true;
  const normalized = filename.toLowerCase();
  if (normalized === "document-note.txt") return true;
  if (provenanceKind === "learned" && normalized === "user-document.txt") {
    return true;
  }
  return false;
}

export function normalizeDocumentSource(
  source: unknown,
): DocumentProvenanceKind {
  switch (source) {
    case "upload":
    case "rag-service-main-upload":
      return "upload";
    case "learned":
      return "learned";
    case "character":
      return "character";
    case "url":
      return "url";
    case "youtube":
      return "youtube";
    case "eliza-default-documents":
      return "bundled";
    default:
      return "unknown";
  }
}

export function getDocumentProvenance(
  metadata: Record<string, unknown> | undefined,
): DocumentProvenance {
  const kind = normalizeDocumentSource(metadata?.source);
  switch (kind) {
    case "upload":
      return { kind, label: "Manual upload" };
    case "learned":
      return { kind, label: "Learned document" };
    case "character":
      return {
        kind,
        label: "Character document",
        detail: asString(metadata?.path),
      };
    case "url":
      return {
        kind,
        label: "Imported URL",
        detail: asString(metadata?.url),
      };
    case "youtube":
      return {
        kind,
        label: "YouTube transcript",
        detail: asString(metadata?.url),
      };
    case "bundled":
      return { kind, label: "Bundled document" };
    default:
      return { kind, label: "Document" };
  }
}

export function getDocumentContentType(
  metadata: Record<string, unknown> | undefined,
): string {
  return (
    asString(metadata?.fileType) ?? asString(metadata?.contentType) ?? "unknown"
  );
}

export function getDocumentTitleFromMetadata(
  metadata: Record<string, unknown> | undefined,
  contentText?: string,
): string {
  const provenance = getDocumentProvenance(metadata);
  const filename = asString(metadata?.filename);
  const title = asString(metadata?.title);
  const originalFilename = asString(metadata?.originalFilename);
  const url = asString(metadata?.url);

  if (filename && !isGenericFilename(filename, provenance.kind)) {
    return filename;
  }
  if (title) return title;
  if (
    originalFilename &&
    !isGenericFilename(originalFilename, provenance.kind)
  ) {
    return originalFilename;
  }
  if (url) return url;
  return deriveTitleFromText(contentText, "Untitled");
}

export function getDocumentVisibilityScope(
  metadata: Record<string, unknown> | undefined,
): DocumentVisibilityScope {
  return DOCUMENT_SCOPE_VALUES.has(metadata?.scope as DocumentVisibilityScope)
    ? (metadata?.scope as DocumentVisibilityScope)
    : "global";
}

export function isDocumentTextBacked(memory: Memory): boolean {
  const metadata = asRecord(memory.metadata);
  if (typeof metadata?.textBacked === "boolean") {
    return metadata.textBacked;
  }

  const filename = getDocumentTitleFromMetadata(metadata, memory.content?.text);
  const contentType = getDocumentContentType(metadata);
  if (isBinaryLike(contentType, filename)) {
    return false;
  }

  const contentText = memory.content?.text;
  if (typeof contentText !== "string" || contentText.trim().length === 0) {
    return false;
  }

  return !looksLikeBase64(contentText);
}

export function getDocumentPreviewText(memory: Memory): string | undefined {
  const contentText = memory.content?.text;
  if (typeof contentText !== "string") return undefined;
  const trimmed = contentText.trim();
  if (trimmed.length === 0 || looksLikeBase64(trimmed)) {
    return undefined;
  }
  return trimmed;
}

export function getDocumentEditability(memory: Memory): {
  canEditText: boolean;
  reason?: string;
} {
  const metadata = asRecord(memory.metadata);
  const provenance = getDocumentProvenance(metadata);

  if (provenance.kind === "bundled") {
    return {
      canEditText: false,
      reason: "Bundled documents are seeded by the runtime.",
    };
  }

  if (provenance.kind === "character") {
    return {
      canEditText: false,
      reason: "Character documents come from source files or character config.",
    };
  }

  if (!isDocumentTextBacked(memory)) {
    return {
      canEditText: false,
      reason: "Only text-backed documents can be edited here.",
    };
  }

  return { canEditText: true };
}

export function getDocumentDeleteability(memory: Memory): {
  canDelete: boolean;
  reason?: string;
} {
  const provenance = getDocumentProvenance(asRecord(memory.metadata));
  if (provenance.kind === "bundled") {
    return {
      canDelete: false,
      reason: "Bundled documents are recreated by the runtime.",
    };
  }

  if (provenance.kind === "character") {
    return {
      canDelete: false,
      reason: "Character documents are backed by the character source.",
    };
  }

  return { canDelete: true };
}

export function presentDocument(
  memory: Memory,
  fragmentCount: number,
  options?: { includeContent?: boolean },
): PresentedDocument {
  const metadata = asRecord(memory.metadata);
  const provenance = getDocumentProvenance(metadata);
  const contentType = getDocumentContentType(metadata);
  const previewText = options?.includeContent
    ? getDocumentPreviewText(memory)
    : undefined;
  const editability = getDocumentEditability(memory);
  const deleteability = getDocumentDeleteability(memory);

  return {
    id: String(memory.id ?? ""),
    filename: getDocumentTitleFromMetadata(metadata, memory.content?.text),
    contentType,
    fileSize: asNumber(metadata?.fileSize) ?? 0,
    createdAt: asNumber(memory.createdAt) ?? 0,
    fragmentCount,
    source: provenance.kind,
    scope: getDocumentVisibilityScope(metadata),
    scopedToEntityId: asString(metadata?.scopedToEntityId),
    addedBy: asString(metadata?.addedBy),
    addedByRole: asString(metadata?.addedByRole),
    addedFrom: asString(metadata?.addedFrom),
    url: asString(metadata?.url),
    provenance,
    canEditText: editability.canEditText,
    editabilityReason: editability.reason,
    canDelete: deleteability.canDelete,
    deleteabilityReason: deleteability.reason,
    ...(previewText ? { content: { text: previewText } } : {}),
  };
}
