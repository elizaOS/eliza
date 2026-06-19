import sharp from "sharp";

export const MAX_VISION_IMAGE_BYTES = 25 * 1024 * 1024;

const SUPPORTED_FORMATS = new Set(["jpeg", "png", "webp"]);
const MIME_BY_FORMAT: Record<string, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
};

export interface ValidatedVisionImage {
  readonly width: number;
  readonly height: number;
  readonly format: "jpeg" | "png" | "webp";
  readonly contentType: "image/jpeg" | "image/png" | "image/webp";
}

export function estimateBase64DecodedBytes(base64: string): number {
  const trimmed = base64.trim();
  if (!trimmed) return 0;
  const padding = trimmed.endsWith("==") ? 2 : trimmed.endsWith("=") ? 1 : 0;
  return Math.floor((trimmed.length * 3) / 4) - padding;
}

export function parseVisionDataImageUrl(value: string): {
  mimeType: string;
  base64: string;
} {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Image URL must be a non-empty data URL");
  }
  if (!value.startsWith("data:")) {
    throw new Error("Only data image URLs are supported for vision input");
  }
  const commaIndex = value.indexOf(",");
  if (commaIndex < 0) {
    throw new Error("Malformed data image URL");
  }
  const header = value.slice(5, commaIndex);
  const payload = value.slice(commaIndex + 1);
  const parts = header.split(";").map((part) => part.toLowerCase());
  const mimeType = parts[0] ?? "";
  if (!SUPPORTED_FORMATS.has(mimeType.replace(/^image\//, ""))) {
    throw new Error(`Unsupported image media type: ${mimeType || "unknown"}`);
  }
  if (!parts.includes("base64")) {
    throw new Error("Vision data image URL must be base64 encoded");
  }
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) {
    throw new Error("Malformed base64 image payload");
  }
  if (estimateBase64DecodedBytes(payload) > MAX_VISION_IMAGE_BYTES) {
    throw new Error(
      `Image payload exceeds ${MAX_VISION_IMAGE_BYTES} byte limit`,
    );
  }
  return { mimeType, base64: payload };
}

export async function assertValidVisionImageBuffer(
  data: Buffer,
): Promise<ValidatedVisionImage> {
  if (!Buffer.isBuffer(data) || data.length === 0) {
    throw new Error("Image data must be a non-empty Buffer");
  }
  if (data.length > MAX_VISION_IMAGE_BYTES) {
    throw new Error(`Image data exceeds ${MAX_VISION_IMAGE_BYTES} byte limit`);
  }

  let metadata: sharp.Metadata;
  try {
    metadata = await sharp(data, { limitInputPixels: 100_000_000 }).metadata();
  } catch (error) {
    throw new Error(
      `Malformed image input: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const format = metadata.format;
  if (!format || !SUPPORTED_FORMATS.has(format)) {
    throw new Error(`Unsupported image media type: ${format || "unknown"}`);
  }
  if (!metadata.width || !metadata.height) {
    throw new Error(
      `Invalid image dimensions: ${metadata.width}x${metadata.height}`,
    );
  }

  return {
    width: metadata.width,
    height: metadata.height,
    format: format as ValidatedVisionImage["format"],
    contentType: MIME_BY_FORMAT[format] as ValidatedVisionImage["contentType"],
  };
}

export async function assertSafeVisionDataImageUrl(
  imageUrl: string,
): Promise<ValidatedVisionImage> {
  const { base64 } = parseVisionDataImageUrl(imageUrl);
  return assertValidVisionImageBuffer(Buffer.from(base64, "base64"));
}
