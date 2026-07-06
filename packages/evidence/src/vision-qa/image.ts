/**
 * Image preparation for VLM Q&A: downscale a screenshot's longest edge to a
 * cost cap and encode it as base64 for the request body. Vision models bill by
 * image tokens roughly proportional to pixel area, and Anthropic itself
 * downsamples anything past ~1568px on the longest edge — sending larger pixels
 * only burns tokens for detail the model discards. We downscale here, once, and
 * record both the original and sent dimensions so the qa.json provenance shows
 * exactly what the model saw. Sharp is the repo-standard raster tool
 * (`packages/app-core`, `packages/app`); the encoded MIME type is derived from
 * the decoded pixels, never trusted from the file extension.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import sharp from "sharp";
import { EvidenceError } from "../errors.ts";
import type { ImageDimensions } from "./types.ts";

/** Anthropic downsamples past this longest edge; matching it avoids wasted tokens. */
export const DEFAULT_MAX_EDGE = 1568;

/** Sharp output formats we emit and their canonical media types. */
const MEDIA_TYPE_BY_FORMAT: Record<string, string> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
};

/** A prepared image ready to embed in a request body. */
export interface PreparedImage {
  /** Base64 (no data-URI prefix) of the downscaled bytes. */
  base64: string;
  /** e.g. `image/png` — derived from the decoded pixels. */
  mediaType: string;
  dimensions: ImageDimensions;
  /** sha256 of the ORIGINAL file bytes — the cache's image key. */
  sourceSha256: string;
}

/**
 * Compute the scaled dimensions that fit `maxEdge` while preserving aspect,
 * never upscaling. Rounds to whole pixels; a zero-area result is impossible for
 * a valid raster because both source dimensions are >= 1.
 */
export function scaleToMaxEdge(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge) return { width, height };
  const ratio = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * ratio)),
    height: Math.max(1, Math.round(height * ratio)),
  };
}

/**
 * Read `imagePath`, downscale its longest edge to `maxEdge`, and return the
 * base64-encoded bytes plus the dimensions and source hash. Re-encodes in the
 * source format (PNG stays PNG) so a screenshot's crisp text is not JPEG-blurred
 * before the model reads it. An unreadable or non-raster file throws typed —
 * a Q&A run must not proceed against an image the model never actually saw.
 */
export async function prepareImage(
  imagePath: string,
  maxEdge: number = DEFAULT_MAX_EDGE,
): Promise<PreparedImage> {
  let sourceBytes: Buffer;
  try {
    sourceBytes = fs.readFileSync(imagePath);
  } catch (error) {
    // error-policy:J2 context-adding rethrow — a missing image must fail the
    // ask, not degrade to a blank/absent-image request.
    throw new EvidenceError(`vision-qa image unreadable: ${imagePath}`, {
      code: "VISION_IMAGE_UNREADABLE",
      cause: error,
      context: { imagePath },
    });
  }
  const sourceSha256 = createHash("sha256").update(sourceBytes).digest("hex");

  const pipeline = sharp(sourceBytes, { failOn: "error" });
  let metadata: sharp.Metadata;
  try {
    metadata = await pipeline.metadata();
  } catch (error) {
    // error-policy:J3 untrusted input — bytes that are not a decodable raster
    // (wrong extension, truncated, plain text) fail the ask typed, never a
    // blank-image request.
    throw new EvidenceError(`vision-qa could not decode image: ${imagePath}`, {
      code: "VISION_IMAGE_UNDECODABLE",
      cause: error,
      context: { imagePath },
    });
  }
  const originalWidth = metadata.width;
  const originalHeight = metadata.height;
  const format = metadata.format;
  if (
    originalWidth === undefined ||
    originalHeight === undefined ||
    format === undefined
  ) {
    throw new EvidenceError(
      `vision-qa could not decode image dimensions: ${imagePath}`,
      { code: "VISION_IMAGE_UNDECODABLE", context: { imagePath } },
    );
  }
  const mediaType = MEDIA_TYPE_BY_FORMAT[format];
  if (mediaType === undefined) {
    throw new EvidenceError(
      `vision-qa unsupported image format '${format}': ${imagePath}`,
      { code: "VISION_IMAGE_FORMAT", context: { imagePath, format } },
    );
  }

  const scaled = scaleToMaxEdge(originalWidth, originalHeight, maxEdge);
  const resized =
    scaled.width === originalWidth && scaled.height === originalHeight
      ? pipeline
      : pipeline.resize(scaled.width, scaled.height, { fit: "inside" });
  const encoded = await resized.toFormat(format).toBuffer();

  return {
    base64: encoded.toString("base64"),
    mediaType,
    dimensions: {
      originalWidth,
      originalHeight,
      sentWidth: scaled.width,
      sentHeight: scaled.height,
    },
    sourceSha256,
  };
}
