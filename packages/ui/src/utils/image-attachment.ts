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

/**
 * Read supported files (images, audio, video, PDFs, text docs) into base64
 * {@link ImageAttachment} payloads (the `data:<mime>;base64,` prefix stripped).
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
          reader.onload = () => {
            const result = reader.result as string;
            const commaIdx = result.indexOf(",");
            const data = commaIdx >= 0 ? result.slice(commaIdx + 1) : result;
            resolve({ data, mimeType: file.type, name: file.name });
          };
          reader.onerror = () =>
            reject(reader.error ?? new Error("Failed to read file"));
          reader.onabort = () => reject(new Error("File read aborted"));
          reader.readAsDataURL(file);
        }),
    ),
  );
}
