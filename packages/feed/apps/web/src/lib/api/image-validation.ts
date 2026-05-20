const IMAGE_MAGIC_BYTES: Record<string, number[][]> = {
  "image/jpeg": [
    [0xff, 0xd8, 0xff], // JPEG/JFIF
  ],
  "image/png": [
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], // PNG
  ],
  "image/gif": [
    [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], // GIF87a
    [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], // GIF89a
  ],
};

/** WebP magic bytes: RIFF at bytes 0-3, WEBP at bytes 8-11 */
const WEBP_RIFF_HEADER = [0x52, 0x49, 0x46, 0x46]; // "RIFF"
const WEBP_FORMAT_MARKER = [0x57, 0x45, 0x42, 0x50]; // "WEBP"

/**
 * Validates that file bytes match the declared MIME type.
 * Prevents uploading executables disguised as images.
 */
export function validateImageMagicBytes(
  buffer: Buffer,
  mimeType: string,
): boolean {
  // WebP requires special handling: RIFF container at bytes 0-3,
  // file size at bytes 4-7 (variable), WEBP marker at bytes 8-11
  if (mimeType === "image/webp") {
    if (buffer.length < 12) return false;
    const hasRiffHeader = WEBP_RIFF_HEADER.every(
      (byte, i) => buffer[i] === byte,
    );
    const hasWebpMarker = WEBP_FORMAT_MARKER.every(
      (byte, i) => buffer[8 + i] === byte,
    );
    return hasRiffHeader && hasWebpMarker;
  }

  const signatures = IMAGE_MAGIC_BYTES[mimeType];
  if (!signatures) {
    return false;
  }

  return signatures.some((signature) => {
    if (buffer.length < signature.length) return false;
    return signature.every((byte, i) => buffer[i] === byte);
  });
}
