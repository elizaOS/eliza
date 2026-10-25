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

/**
 * Decode-time safety bounds. The pure-JS codecs allocate `width*height*4`
 * bytes of RGBA with no guard of their own, and the upload validator caps only
 * the *compressed* size — a tiny solid-color PNG can declare dimensions whose
 * decode would allocate gigabytes and take the process down. Dimensions are
 * read from the container header and rejected before any decode runs.
 */
const MAX_DECODE_EDGE_PX = 8192;
const MAX_DECODE_PIXELS = 16_777_216; // 16 Mi px → ≤64 MiB RGBA

interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Dimensions from the PNG signature + IHDR header (BE u32 at bytes 16/20).
 * Fails closed on Adam7-interlaced inputs (IHDR byte 12, file offset 28):
 * pngjs bounds its inflate with a dimension-derived `maxLength` only on the
 * non-interlaced branch — the interlaced branch inflates with no output cap,
 * so a small IHDR attached to a huge IDAT decompresses unbounded. Skipping
 * the thumbnail is graceful: callers serve the original bytes instead.
 */
function readPngDimensions(source: Buffer): ImageDimensions | null {
  if (source.length < 29) return null;
  if (source.readUInt32BE(0) !== 0x89504e47) return null;
  if (source.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (source.toString("ascii", 12, 16) !== "IHDR") return null;
  if (source[28] !== 0) return null;
  return { width: source.readUInt32BE(16), height: source.readUInt32BE(20) };
}

/**
 * Dimensions from the JPEG SOFn segment. Walks the marker stream from the SOI:
 * every segment is `FF <marker> <u16 length>` except the standalone markers
 * (SOI/RSTn/TEM) that carry no length. Fails closed on a second SOFn: jpeg-js
 * eagerly allocates every declared frame's MCU blocks at SOF parse and only
 * afterwards throws on multi-frame input, so a small first SOF followed by a
 * bomb SOF must be rejected here, before decode. Multi-frame streams can never
 * decode successfully anyway, so no thumbnailable input is lost.
 */
function readJpegDimensions(source: Buffer): ImageDimensions | null {
  if (source.length < 4 || source[0] !== 0xff || source[1] !== 0xd8) {
    return null;
  }
  let dimensions: ImageDimensions | null = null;
  let offset = 2;
  while (offset + 4 <= source.length) {
    if (source[offset] !== 0xff) return null;
    const marker = source[offset + 1];
    // SOS opens entropy-coded scan data, which is not length-delimited — the
    // header walk ends here (a second SOF after scan data is caught by the
    // decode-time memory bound instead).
    if (marker === 0xda) break;
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      offset += 2;
      continue;
    }
    const segmentLength = source.readUInt16BE(offset + 2);
    if (segmentLength < 2 || offset + 2 + segmentLength > source.length) {
      return null;
    }
    // SOF0–SOF15 carry the frame dimensions; exclude DHT (C4), JPG (C8), DAC (CC).
    if (
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      if (segmentLength < 7) return null;
      if (dimensions !== null) return null;
      dimensions = {
        height: source.readUInt16BE(offset + 5),
        width: source.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + segmentLength;
  }
  return dimensions;
}

/** True when the declared dimensions stay within the decode-time bounds. */
function withinDecodeBounds(dimensions: ImageDimensions): boolean {
  const { width, height } = dimensions;
  if (width <= 0 || height <= 0) return false;
  if (width > MAX_DECODE_EDGE_PX || height > MAX_DECODE_EDGE_PX) return false;
  return width * height <= MAX_DECODE_PIXELS;
}

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
    opts?: {
      useTArray?: boolean;
      formatAsRGBA?: boolean;
      maxResolutionInMP?: number;
      maxMemoryUsageInMB?: number;
    },
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
 * input isn't a supported raster, is already within bounds, declares dimensions
 * beyond the decode-time safety bounds, the codecs are unavailable, or decoding
 * fails.
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
    // Bound the decode before the codecs allocate width*height*4 bytes: a
    // compressed input under the upload size cap can still declare bomb
    // dimensions. Unparseable headers fail closed — decode would fail anyway.
    const dimensions = isPng
      ? readPngDimensions(source)
      : readJpegDimensions(source);
    if (!dimensions || !withinDecodeBounds(dimensions)) return null;
    const decoded: RawImage = isPng
      ? loaded.png.sync.read(source)
      : // Back the header pre-check with jpeg-js's own per-SOF pixel cap and
        // cumulative allocation budget (64 MiB matches the RGBA bound above):
        // a second SOF hiding behind scan data still can't inflate memory.
        loaded.jpeg.decode(source, {
          useTArray: true,
          formatAsRGBA: true,
          maxResolutionInMP: MAX_DECODE_PIXELS / 1_000_000,
          maxMemoryUsageInMB: (MAX_DECODE_PIXELS * 4) / (1024 * 1024),
        });
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
