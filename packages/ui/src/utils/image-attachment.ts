import type { ImageAttachment } from "../api/client-types-chat";

/**
 * Server-side cap (MAX_CHAT_IMAGES) mirrored client-side so the user gets
 * immediate feedback rather than a 400 after upload. Applies to all attachment
 * kinds, not just images.
 */
export const MAX_CHAT_IMAGES = 4;

/**
 * Per-file size cap for a chat attachment, in bytes (20 MB). Enforced
 * client-side so an oversized file is rejected with a clear notice up front
 * rather than silently sliced or failing with a 413 after upload.
 */
export const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;

/**
 * Combined size cap across all attachments on a single message, in bytes
 * (60 MB). Even when every individual file is under {@link MAX_ATTACHMENT_BYTES}
 * the batch as a whole is bounded so a handful of large-but-legal files can't
 * blow the request body.
 */
export const MAX_ATTACHMENTS_TOTAL_BYTES = 60 * 1024 * 1024;

/** Human-readable MB for a byte cap, used in user-facing notices. */
export function bytesToMb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}

/** A file that was rejected during intake, with the reason it was dropped. */
export interface DroppedFile {
  name: string;
  /** Why the file was rejected. */
  reason: "too-large" | "over-count";
}

/** Outcome of partitioning a candidate file list against the size/count caps. */
export interface PartitionedAttachmentFiles {
  /** Files that passed every cap and should be read into attachments. */
  accepted: File[];
  /** Files rejected because they (or the running total) exceeded a byte cap. */
  droppedTooLarge: DroppedFile[];
  /** Files rejected because they exceeded the per-message count cap. */
  droppedOverCount: DroppedFile[];
}

export interface PartitionAttachmentFilesOptions {
  /** Per-file byte cap. Defaults to {@link MAX_ATTACHMENT_BYTES}. */
  maxBytes?: number;
  /** Combined byte cap. Defaults to {@link MAX_ATTACHMENTS_TOTAL_BYTES}. */
  maxTotalBytes?: number;
  /** Max number of accepted files. Defaults to {@link MAX_CHAT_IMAGES}. */
  maxCount?: number;
  /**
   * Count of attachments already pending on the composer, so the count cap is
   * applied against the combined total rather than just this batch.
   */
  existingCount?: number;
}

/**
 * Pure size/count gate for attachment intake. Walks the candidate files in
 * order and partitions them into accepted vs. dropped, recording *why* each
 * file was dropped (oversized vs. over the per-message count) so the caller can
 * surface a "kept N, dropped M" notice instead of silently truncating.
 *
 * Order of checks per file: per-file byte cap → running-total byte cap →
 * count cap. A file that trips any byte cap is reported as `too-large`; a file
 * that only trips the count cap is reported as `over-count`.
 */
export function partitionAttachmentFiles(
  files: FileList | File[],
  options: PartitionAttachmentFilesOptions = {},
): PartitionedAttachmentFiles {
  const maxBytes = options.maxBytes ?? MAX_ATTACHMENT_BYTES;
  const maxTotalBytes = options.maxTotalBytes ?? MAX_ATTACHMENTS_TOTAL_BYTES;
  const maxCount = options.maxCount ?? MAX_CHAT_IMAGES;
  const existingCount = options.existingCount ?? 0;

  const accepted: File[] = [];
  const droppedTooLarge: DroppedFile[] = [];
  const droppedOverCount: DroppedFile[] = [];

  let runningBytes = 0;
  for (const file of Array.from(files)) {
    const size = file.size ?? 0;
    if (size > maxBytes || runningBytes + size > maxTotalBytes) {
      droppedTooLarge.push({ name: file.name, reason: "too-large" });
      continue;
    }
    if (existingCount + accepted.length >= maxCount) {
      droppedOverCount.push({ name: file.name, reason: "over-count" });
      continue;
    }
    accepted.push(file);
    runningBytes += size;
  }

  return { accepted, droppedTooLarge, droppedOverCount };
}

/** `accept` attribute for the chat upload <input> — images, audio, video, PDFs, text docs. */
export const CHAT_UPLOAD_ACCEPT =
  "image/*,audio/*,video/*,application/pdf,text/plain,text/csv,text/markdown";

/** True when a file's MIME type is an attachment kind chat upload accepts. */
export function isSupportedChatUpload(file: File): boolean {
  const mime = file.type.toLowerCase();
  return (
    mime.startsWith("image/") ||
    mime.startsWith("audio/") ||
    mime.startsWith("video/") ||
    mime === "application/pdf" ||
    mime === "text/plain" ||
    mime === "text/csv" ||
    mime === "text/markdown"
  );
}

/** Map a MIME type to the rendered attachment kind (for preview tiles). */
export function chatUploadKind(
  mimeType: string,
): "image" | "audio" | "video" | "document" {
  const mime = mimeType.toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  return "document";
}

/** Longest edge (px) of a generated thumbnail. */
const THUMBNAIL_MAX_DIM = 512;
/** Don't bother thumbnailing images smaller than this — the original is light enough. */
const THUMBNAIL_MIN_SOURCE_BYTES = 96 * 1024;

function readFileAsImageElement(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to decode image"));
    };
    img.src = url;
  });
}

/**
 * Generate a downscaled JPEG thumbnail for a large image, entirely client-side
 * via `<canvas>` (works in every browser/desktop/iOS/Android webview — no
 * native deps). Returns base64 (no data-URL prefix) + mime, or null when the
 * file isn't a raster image, is already small, or can't be decoded. JPEG +
 * `<canvas>.toDataURL` is used for universal webview support (WebP/OffscreenCanvas
 * are not reliable on older WKWebView).
 */
export async function createImageThumbnail(
  file: File,
): Promise<{ data: string; mimeType: string } | null> {
  const mime = file.type.toLowerCase();
  if (
    !mime.startsWith("image/") ||
    mime === "image/gif" ||
    mime === "image/svg+xml"
  ) {
    return null;
  }
  if (file.size < THUMBNAIL_MIN_SOURCE_BYTES) return null;
  if (typeof document === "undefined") return null;
  try {
    const img = await readFileAsImageElement(file);
    const longest = Math.max(img.width, img.height);
    if (!longest) return null;
    const scale = THUMBNAIL_MAX_DIM / longest;
    if (scale >= 1) return null; // already within the thumbnail bound
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.72);
    const commaIdx = dataUrl.indexOf(",");
    if (commaIdx < 0 || !dataUrl.startsWith("data:image/")) return null;
    return { data: dataUrl.slice(commaIdx + 1), mimeType: "image/jpeg" };
  } catch {
    return null;
  }
}

/**
 * Read supported files (images, audio, video, PDFs, text docs) into base64
 * {@link ImageAttachment} payloads (the `data:<mime>;base64,` prefix stripped).
 * Image uploads also get a client-generated thumbnail when large enough.
 * Unsupported files are skipped; oversized files (per-file or in aggregate) are
 * filtered out via {@link partitionAttachmentFiles} so an over-cap upload can
 * never silently slip through to the server. The promise rejects if any read
 * fails so the caller can surface it rather than silently dropping an
 * attachment. Shared by the chat composer and the continuous chat overlay.
 *
 * Note: only the per-file / total *byte* caps are enforced here; the count cap
 * is left to the caller (it slices the merged pending list), and drop reporting
 * for a user-facing notice lives in {@link intakeAttachmentFiles}.
 */
export function filesToImageAttachments(
  files: FileList | File[],
): Promise<ImageAttachment[]> {
  const supported = Array.from(files).filter(isSupportedChatUpload);
  // Enforce byte caps centrally so every caller (composer + continuous chat
  // overlay) drops oversized files rather than shipping them to the server.
  // Count is enforced by the caller, so allow the full count here.
  const { accepted } = partitionAttachmentFiles(supported, {
    maxCount: Number.POSITIVE_INFINITY,
  });
  return Promise.all(
    accepted.map(
      (file) =>
        new Promise<ImageAttachment>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = async () => {
            const result = reader.result as string;
            const commaIdx = result.indexOf(",");
            const data = commaIdx >= 0 ? result.slice(commaIdx + 1) : result;
            const thumbnail = await createImageThumbnail(file).catch(
              () => null,
            );
            resolve({
              data,
              mimeType: file.type,
              name: file.name,
              ...(thumbnail ? { thumbnail } : {}),
            });
          };
          reader.onerror = () =>
            reject(reader.error ?? new Error("Failed to read file"));
          reader.onabort = () => reject(new Error("File read aborted"));
          reader.readAsDataURL(file);
        }),
    ),
  );
}

/** Result of {@link intakeAttachmentFiles}: the read attachments plus drops. */
export interface AttachmentIntakeResult {
  attachments: ImageAttachment[];
  droppedTooLarge: DroppedFile[];
  droppedOverCount: DroppedFile[];
}

/**
 * Full intake pipeline for the chat composer: filters unsupported files,
 * applies the byte and count caps via {@link partitionAttachmentFiles}, reads
 * the accepted files into {@link ImageAttachment} payloads, and returns the
 * dropped files (with reasons) alongside — so the caller can surface a
 * "kept N, dropped M" notice instead of silently truncating. Rejects only if a
 * read of an accepted file fails.
 */
export async function intakeAttachmentFiles(
  files: FileList | File[],
  options: PartitionAttachmentFilesOptions = {},
): Promise<AttachmentIntakeResult> {
  const supported = Array.from(files).filter(isSupportedChatUpload);
  const { accepted, droppedTooLarge, droppedOverCount } =
    partitionAttachmentFiles(supported, options);
  const attachments = await filesToImageAttachments(accepted);
  return { attachments, droppedTooLarge, droppedOverCount };
}

/**
 * Build the i18n params for a "kept N, dropped M" notice from an intake/
 * partition result, or `null` when nothing was dropped (no notice needed).
 * Pure + testable so the composer just renders the returned counts.
 */
export function summarizeDroppedAttachments(result: {
  acceptedCount: number;
  droppedTooLarge: DroppedFile[];
  droppedOverCount: DroppedFile[];
}): {
  kept: number;
  dropped: number;
  droppedTooLarge: number;
  droppedOverCount: number;
  maxMb: number;
} | null {
  const droppedTooLarge = result.droppedTooLarge.length;
  const droppedOverCount = result.droppedOverCount.length;
  const dropped = droppedTooLarge + droppedOverCount;
  if (dropped === 0) return null;
  return {
    kept: result.acceptedCount,
    dropped,
    droppedTooLarge,
    droppedOverCount,
    maxMb: bytesToMb(MAX_ATTACHMENT_BYTES),
  };
}

/**
 * Character count at/above which a plain-text paste is converted into a
 * collapsed text attachment chip (Claude-Code / claude.ai style) rather than
 * flooding the composer textarea. Pastes shorter than this go into the textarea
 * as normal.
 */
export const LARGE_PASTE_CHAR_THRESHOLD = 2000;

/**
 * True when a pasted plain-text block is large enough to become a text
 * attachment instead of landing in the textarea. Uses the *trimmed* length so
 * surrounding whitespace can't push a small paste over the line. A single bare
 * URL (no internal whitespace) is never converted — pasting a link should keep
 * working normally even when the URL is very long.
 */
export function shouldConvertPasteToAttachment(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < LARGE_PASTE_CHAR_THRESHOLD) return false;
  // A lone long URL is a link, not a document — keep it in the textarea.
  if (/^https?:\/\/\S+$/i.test(trimmed)) return false;
  return true;
}

/**
 * Encode a string to base64 in a UTF-8-safe, chunk-safe way. Raw `btoa(text)`
 * throws on any code point > 0xFF (so any non-ASCII / emoji paste would break),
 * and `String.fromCharCode(...bytes)` can overflow the call stack on a large
 * paste. This walks the UTF-8 bytes in fixed-size chunks instead, so it round-
 * trips arbitrary Unicode of any length.
 */
function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** Default file name for a pasted-text attachment. */
const PASTED_TEXT_DEFAULT_NAME = "pasted-text.md";

/**
 * Convert a large pasted plain-text block into an {@link ImageAttachment} (the
 * shared chat-attachment shape) so it renders as a collapsed chip and ships to
 * the server like any other attachment. `data` is the UTF-8-safe base64 of the
 * text (no data-URL prefix, matching the other attachment producers here),
 * `mimeType` is `text/markdown`, and there is no thumbnail. Pure + synchronous
 * so it unit-tests without the DOM.
 */
export function pastedTextToAttachment(
  text: string,
  opts: { name?: string } = {},
): ImageAttachment {
  return {
    data: utf8ToBase64(text),
    mimeType: "text/markdown",
    name: opts.name ?? PASTED_TEXT_DEFAULT_NAME,
  };
}

/**
 * Classify a composer paste so both chat surfaces handle clipboard pastes
 * identically. Returns either:
 *  - `{ kind: "files" }` — the paste carried image/file data; the caller should
 *    `preventDefault()` and run the files through {@link intakeAttachmentFiles}.
 *  - `{ kind: "text-attachment", attachment }` — a large plain-text paste that
 *    should become a collapsed text-attachment chip (`preventDefault()` first).
 *  - `{ kind: "passthrough" }` — nothing to intercept; let the textarea handle
 *    the paste normally (small text, or a lone URL).
 * Pure + DOM-free so it unit-tests without a real ClipboardEvent.
 */
export type ComposerPasteIntent =
  | { kind: "files"; files: File[] }
  | { kind: "text-attachment"; attachment: ImageAttachment }
  | { kind: "passthrough" };

export function classifyComposerPaste(data: {
  files: File[];
  text: string;
}): ComposerPasteIntent {
  if (data.files.length > 0) {
    return { kind: "files", files: data.files };
  }
  if (shouldConvertPasteToAttachment(data.text)) {
    return {
      kind: "text-attachment",
      attachment: pastedTextToAttachment(data.text),
    };
  }
  return { kind: "passthrough" };
}

/**
 * Build the translated "kept N, dropped M" notice for the composer from an
 * intake/partition result, choosing the right i18n key based on whether the
 * drops were oversized, over-count, or a mix. Returns `null` when nothing was
 * dropped. Pure (takes the `t` translator) so it's testable without React.
 */
export function buildDroppedAttachmentNotice(
  result: {
    acceptedCount: number;
    droppedTooLarge: DroppedFile[];
    droppedOverCount: DroppedFile[];
  },
  t: (key: string, options?: Record<string, unknown>) => string,
): string | null {
  const summary = summarizeDroppedAttachments(result);
  if (!summary) return null;

  const { kept, dropped, droppedTooLarge, droppedOverCount, maxMb } = summary;
  if (droppedTooLarge > 0 && droppedOverCount > 0) {
    return t("chat.attachmentsKeptDroppedMixed", {
      kept,
      dropped,
      tooLarge: droppedTooLarge,
      overCount: droppedOverCount,
      maxMb,
    });
  }
  if (droppedOverCount > 0) {
    return t("chat.attachmentsKeptDroppedOverCount", { kept, dropped });
  }
  return t("chat.attachmentsKeptDroppedTooLarge", { kept, dropped, maxMb });
}
