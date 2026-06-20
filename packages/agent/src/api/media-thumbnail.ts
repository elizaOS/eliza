/**
 * Portable server-side image thumbnailing — pure-JS (pngjs + jpeg-js), no
 * native `sharp` (which can't load in the mobile JS bundle) and no jimp (whose
 * `@jimp/*` sub-packages don't resolve cleanly under bun's hoisting). The two
 * codecs are dynamically imported behind an indirected specifier so the mobile
 * bundler doesn't pull them in and every failure path returns null — callers
 * degrade gracefully to serving the full image.
 *
 * Covers PNG + JPEG, which is what agent-generated / connector-ingested images
 * are; browser/webview uploads already thumbnail client-side via `<canvas>` and
 * cover every other format (webp, etc.).
 */

import { logger } from "@elizaos/core";

/** Longest edge (px) of a generated thumbnail — matches the client-side bound. */
const THUMBNAIL_MAX_DIM = 512;
const THUMBNAILABLE_MIME = /^image\/(png|jpe?g)$/i;

const PNGJS_MODULE_ID = "pngjs";
const JPEGJS_MODULE_ID = "jpeg-js";

interface RawImage {
  width: number;
  height: number;
  data: Uint8Array; // RGBA, row-major
}

interface PngStatic {
  sync: {
    read: (buf: Buffer) => RawImage;
  };
}
interface JpegStatic {
  decode: (
    buf: Buffer,
    opts?: { useTArray?: boolean; formatAsRGBA?: boolean },
  ) => RawImage;
  encode: (img: RawImage, quality?: number) => { data: Buffer };
}

let codecs: { png: PngStatic; jpeg: JpegStatic } | null = null;
let codecLoadAttempted = false;

async function loadCodecs(): Promise<typeof codecs> {
  if (codecLoadAttempted) return codecs;
  codecLoadAttempted = true;
  try {
    const pngMod = (await import(PNGJS_MODULE_ID)) as Record<string, unknown>;
    const jpegModRaw = (await import(JPEGJS_MODULE_ID)) as Record<
      string,
      unknown
    >;
    const PNG = pngMod.PNG as PngStatic | undefined;
    const jpeg = (jpegModRaw.default ?? jpegModRaw) as JpegStatic | undefined;
    if (
      PNG?.sync?.read &&
      typeof jpeg?.decode === "function" &&
      typeof jpeg?.encode === "function"
    ) {
      codecs = { png: PNG, jpeg };
    } else {
      codecs = null;
    }
  } catch {
    codecs = null;
  }
  return codecs;
}

/** Area-average downscale of an RGBA buffer (good quality for shrinking). */
function downscaleRGBA(
  src: Uint8Array,
  sw: number,
  sh: number,
  tw: number,
  th: number,
): Buffer {
  const out = Buffer.alloc(tw * th * 4);
  for (let ty = 0; ty < th; ty++) {
    const sy0 = Math.floor((ty * sh) / th);
    const sy1 = Math.max(sy0 + 1, Math.floor(((ty + 1) * sh) / th));
    for (let tx = 0; tx < tw; tx++) {
      const sx0 = Math.floor((tx * sw) / tw);
      const sx1 = Math.max(sx0 + 1, Math.floor(((tx + 1) * sw) / tw));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let n = 0;
      for (let sy = sy0; sy < sy1 && sy < sh; sy++) {
        for (let sx = sx0; sx < sx1 && sx < sw; sx++) {
          const i = (sy * sw + sx) * 4;
          r += src[i];
          g += src[i + 1];
          b += src[i + 2];
          a += src[i + 3];
          n++;
        }
      }
      const o = (ty * tw + tx) * 4;
      out[o] = Math.round(r / n);
      out[o + 1] = Math.round(g / n);
      out[o + 2] = Math.round(b / n);
      out[o + 3] = Math.round(a / n);
    }
  }
  return out;
}

/**
 * Downscale a PNG/JPEG buffer to a ≤512px JPEG thumbnail. Returns null when the
 * input isn't a supported raster, is already within bounds, the codecs are
 * unavailable, or decoding fails.
 */
export async function generateThumbnailBytes(
  source: Buffer,
  srcMimeType: string,
): Promise<{ buffer: Buffer; mimeType: string } | null> {
  if (!THUMBNAILABLE_MIME.test(srcMimeType)) return null;
  const loaded = await loadCodecs();
  if (!loaded) return null;
  try {
    const isPng = /png/i.test(srcMimeType);
    const decoded: RawImage = isPng
      ? loaded.png.sync.read(source)
      : loaded.jpeg.decode(source, { useTArray: true, formatAsRGBA: true });
    const { width, height, data } = decoded;
    const longest = Math.max(width, height);
    if (!longest || longest <= THUMBNAIL_MAX_DIM) return null;
    const scale = THUMBNAIL_MAX_DIM / longest;
    const tw = Math.max(1, Math.round(width * scale));
    const th = Math.max(1, Math.round(height * scale));
    const resized = downscaleRGBA(data, width, height, tw, th);
    const encoded = loaded.jpeg.encode(
      { width: tw, height: th, data: resized },
      72,
    );
    const buffer = Buffer.isBuffer(encoded.data)
      ? encoded.data
      : Buffer.from(encoded.data);
    if (buffer.length === 0) return null;
    return { buffer, mimeType: "image/jpeg" };
  } catch (err) {
    logger.debug(
      `[media-thumbnail] generation failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
}
