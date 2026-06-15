import type { ImageAttachment } from "../api/client-types-chat";

/**
 * Server-side cap (MAX_CHAT_IMAGES) mirrored client-side so the user gets
 * immediate feedback rather than a 400 after upload.
 */
export const MAX_CHAT_IMAGES = 4;

/**
 * Read image files into base64 {@link ImageAttachment} payloads (the
 * `data:<mime>;base64,` prefix stripped). Non-image files are skipped; the
 * promise rejects if any read fails so the caller can surface it rather than
 * silently dropping an image. Shared by the chat composer and the continuous
 * chat overlay.
 */
export function filesToImageAttachments(
  files: FileList | File[],
): Promise<ImageAttachment[]> {
  const imageFiles = Array.from(files).filter((f) =>
    f.type.startsWith("image/"),
  );
  return Promise.all(
    imageFiles.map(
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
