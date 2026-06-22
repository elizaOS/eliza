/**
 * Turn a user-picked image File into a persistable data URL for use as the app
 * background. Large photos are downscaled (canvas → JPEG) so the stored value
 * stays well under the localStorage quota; a hard size cap rejects anything
 * still too big rather than silently overflowing storage.
 */

const MAX_DIMENSION = 2048;
const JPEG_QUALITY = 0.82;
/** Reject a stored background larger than this — localStorage is ~5 MB total. */
const MAX_DATA_URL_BYTES = 4 * 1024 * 1024;

export class BackgroundImageError extends Error {}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () =>
      reject(reader.error ?? new Error("Could not read the image."));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not decode the image."));
    img.src = src;
  });
}

async function downscaleToDataUrl(dataUrl: string): Promise<string> {
  const img = await loadImage(dataUrl);
  const longest = Math.max(img.width, img.height);
  const scale = longest > 0 ? Math.min(1, MAX_DIMENSION / longest) : 1;
  if (scale >= 1) return dataUrl; // already within bounds
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(img.width * scale);
  canvas.height = Math.round(img.height * scale);
  const ctx = canvas.getContext("2d");
  if (!ctx) return dataUrl;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", JPEG_QUALITY);
}

export async function fileToBackgroundDataUrl(file: File): Promise<string> {
  if (!file.type.startsWith("image/")) {
    throw new BackgroundImageError("Please choose an image file.");
  }
  const raw = await readFileAsDataUrl(file);
  let result = raw;
  try {
    result = await downscaleToDataUrl(raw);
  } catch {
    // Canvas/decoder unavailable — keep the original; the size cap still applies.
    result = raw;
  }
  if (result.length > MAX_DATA_URL_BYTES) {
    throw new BackgroundImageError(
      "That image is too large — try a smaller one.",
    );
  }
  return result;
}
