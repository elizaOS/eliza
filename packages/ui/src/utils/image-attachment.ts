import type { ImageAttachment } from "../api/client-types-chat";

/**
 * Server-side cap (MAX_CHAT_IMAGES) mirrored client-side so the user gets
 * immediate feedback rather than a 400 after upload. Applies to all attachment
 * kinds, not just images.
 */
export const MAX_CHAT_IMAGES = 4;

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
 * Unsupported files are skipped; the promise rejects if any read fails so the
 * caller can surface it rather than silently dropping an attachment. Shared by
 * the chat composer and the continuous chat overlay.
 */
export function filesToImageAttachments(
  files: FileList | File[],
): Promise<ImageAttachment[]> {
  const supported = Array.from(files).filter(isSupportedChatUpload);
  return Promise.all(
    supported.map(
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
