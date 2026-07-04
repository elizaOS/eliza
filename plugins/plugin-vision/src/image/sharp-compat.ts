/**
 * Lazy image processing resolver that keeps plugin-vision loadable on mobile.
 *
 * Runtime call sites reach native sharp through dynamic import so Android
 * bun-musl does not evaluate libvips at module load. Hosts without native sharp
 * receive a Jimp-backed shim for the exact operations covered in
 * `sharp-compat.test.ts`.
 */

import { deflateSync } from "node:zlib";
import { Jimp, JimpMime } from "jimp";

/** Raw-pixel input descriptor (mirrors `sharp.SharpOptions["raw"]`). */
export interface SharpRawInput {
  width: number;
  height: number;
  channels: 1 | 2 | 3 | 4;
}

/** Constructor options subset used by the codebase. */
export interface SharpFactoryOptions {
  raw?: SharpRawInput;
  limitInputPixels?: number | boolean;
  failOnError?: boolean;
}

/** `resize` options subset used by the codebase. */
export interface SharpResizeOptions {
  fit?: "fill" | "contain" | "cover" | "inside" | "outside";
}

/** RGBA background for `extend` (alpha is accepted but encoded outputs only). */
export interface SharpColor {
  r: number;
  g: number;
  b: number;
  alpha?: number;
}

export interface SharpExtendOptions {
  top?: number;
  bottom?: number;
  left?: number;
  right?: number;
  background?: SharpColor;
}

export interface SharpExtractRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** Subset of `sharp.Metadata` the codebase reads. */
export interface SharpMetadata {
  width?: number;
  height?: number;
  channels?: number;
  format?: string;
}

export interface SharpRawInfo {
  width: number;
  height: number;
  channels: number;
}

export interface SharpResolveWithObject {
  data: Buffer;
  info: SharpRawInfo;
}

/**
 * The chainable instance surface. This is structurally the subset of
 * `sharp.Sharp` the codebase touches, so a real `sharp` instance satisfies it
 * and call sites need no per-backend typing.
 */
export interface SharpInstance {
  metadata(): Promise<SharpMetadata>;
  resize(
    width: number,
    height: number,
    options?: SharpResizeOptions,
  ): SharpInstance;
  removeAlpha(): SharpInstance;
  ensureAlpha(): SharpInstance;
  extract(region: SharpExtractRegion): SharpInstance;
  extend(options: SharpExtendOptions): SharpInstance;
  trim(): SharpInstance;
  clone(): SharpInstance;
  png(): SharpInstance;
  jpeg(): SharpInstance;
  raw(): SharpInstance;
  toBuffer(): Promise<Buffer>;
  toBuffer(options: {
    resolveWithObject: true;
  }): Promise<SharpResolveWithObject>;
}

/** The callable factory surface (`sharp(input, options?)`). */
export type SharpFactory = (
  input?: Buffer | Uint8Array,
  options?: SharpFactoryOptions,
) => SharpInstance;

let cached: SharpFactory | null = null;

/**
 * Resolve the image backend. Tries native `sharp` first (dynamic import so the
 * native addon is never touched at module-eval); on any failure falls back to
 * the pure-JS jimp shim. The result is cached for the process lifetime.
 */
export async function getSharp(): Promise<SharpFactory> {
  if (cached) return cached;
  try {
    const mod = (await import("sharp")) as { default: SharpFactory };
    cached = mod.default;
  } catch {
    cached = createJimpShim();
  }
  return cached;
}

// --- pure-JS shim ----------------------------------------------------------

type JimpImage = Awaited<ReturnType<typeof Jimp.read>>;

/** A jimp bitmap is always row-major RGBA. */
interface Bitmap {
  data: Buffer;
  width: number;
  height: number;
}

type OutputFormat = "raw" | "png" | "jpeg";

/**
 * Deferred operation chain. jimp decodes everything to RGBA, so the shim holds
 * a thunk that lazily loads the source pixels, then replays the recorded ops on
 * the bitmap. Channel intent (`removeAlpha` → 3, `ensureAlpha` → 4) is applied
 * only at the terminal raw output to match sharp's channel semantics.
 */
class JimpSharpInstance implements SharpInstance {
  private load: () => Promise<Bitmap>;
  private outputFormat: OutputFormat = "png";
  // null = no explicit alpha op; affects only `.raw()`/`.toBuffer({raw})`.
  private alphaMode: "remove" | "ensure" | null = null;

  constructor(load: () => Promise<Bitmap>) {
    this.load = load;
  }

  private chain(next: (bitmap: Bitmap) => Bitmap | Promise<Bitmap>): this {
    const prev = this.load;
    this.load = async () => next(await prev());
    return this;
  }

  metadata(): Promise<SharpMetadata> {
    return this.load().then((b) => ({
      width: b.width,
      height: b.height,
      channels: hasAlphaPixels(b) ? 4 : 3,
      format: this.outputFormat === "raw" ? "raw" : this.outputFormat,
    }));
  }

  resize(width: number, height: number, options?: SharpResizeOptions): this {
    const fit = options?.fit ?? "cover";
    if (fit !== "fill") {
      throw new Error(
        `[sharp-compat] resize fit "${fit}" is not supported by the pure-JS fallback (only "fill")`,
      );
    }
    return this.chain((b) => {
      const img = bitmapToJimp(b);
      img.resize({ w: width, h: height });
      return jimpToBitmap(img);
    });
  }

  removeAlpha(): this {
    this.alphaMode = "remove";
    return this;
  }

  ensureAlpha(): this {
    this.alphaMode = "ensure";
    return this;
  }

  extract(region: SharpExtractRegion): this {
    // Direct buffer crop — jimp's crop plugin is unreliable under the Node
    // vitest harness, and a sub-rectangle copy needs no codec.
    return this.chain((b) => cropBitmap(b, region));
  }

  extend(options: SharpExtendOptions): this {
    const top = options.top ?? 0;
    const bottom = options.bottom ?? 0;
    const left = options.left ?? 0;
    const right = options.right ?? 0;
    const bg = options.background ?? { r: 0, g: 0, b: 0, alpha: 1 };
    return this.chain((b) => padBitmap(b, top, bottom, left, right, bg));
  }

  trim(): this {
    return this.chain((b) => trimBitmap(b));
  }

  clone(): this {
    const prev = this.load;
    const clone = new JimpSharpInstance(async () => {
      const b = await prev();
      return { data: Buffer.from(b.data), width: b.width, height: b.height };
    });
    clone.outputFormat = this.outputFormat;
    clone.alphaMode = this.alphaMode;
    return clone as this;
  }

  png(): this {
    this.outputFormat = "png";
    return this;
  }

  jpeg(): this {
    this.outputFormat = "jpeg";
    return this;
  }

  raw(): this {
    this.outputFormat = "raw";
    return this;
  }

  toBuffer(): Promise<Buffer>;
  toBuffer(options: {
    resolveWithObject: true;
  }): Promise<SharpResolveWithObject>;
  async toBuffer(options?: {
    resolveWithObject: true;
  }): Promise<Buffer | SharpResolveWithObject> {
    const bitmap = await this.load();
    if (this.outputFormat === "raw") {
      const channels = this.rawChannels(bitmap);
      const data = toRawChannels(bitmap, channels);
      if (options?.resolveWithObject) {
        return {
          data,
          info: { width: bitmap.width, height: bitmap.height, channels },
        };
      }
      return data;
    }

    const dropAlpha = this.alphaMode === "remove";
    let data: Buffer;
    if (this.outputFormat === "jpeg") {
      // jimp's JPEG encoder is correct on both Node and bun; JPEG has no alpha.
      const img = bitmapToJimp(bitmap);
      const encoded = await img.getBuffer(JimpMime.jpeg);
      data = Buffer.isBuffer(encoded) ? encoded : Buffer.from(encoded);
    } else {
      // jimp's PNG encoder is broken under Node 24/25 (pngjs deflate), so encode
      // PNG directly via zlib — works identically on Node and bun, and both
      // sharp and jimp decode the result with exact pixel fidelity.
      data = encodePng(bitmap, dropAlpha);
    }
    if (options?.resolveWithObject) {
      return {
        data,
        info: {
          width: bitmap.width,
          height: bitmap.height,
          channels: dropAlpha ? 3 : 4,
        },
      };
    }
    return data;
  }

  /** Output channel count for raw output, matching sharp's alpha semantics. */
  private rawChannels(bitmap: Bitmap): 3 | 4 {
    if (this.alphaMode === "remove") return 3;
    if (this.alphaMode === "ensure") return 4;
    return hasAlphaPixels(bitmap) ? 4 : 3;
  }
}

/**
 * Construct the pure-JS shim factory directly. Exposed so the compat test can
 * diff the shim against native `sharp` without depending on which backend
 * `getSharp()` happens to resolve on the host.
 */
export function createJimpShim(): SharpFactory {
  return (input, options) => {
    if (options?.raw) {
      if (!input) {
        throw new Error("[sharp-compat] raw input requires a pixel buffer");
      }
      const { width, height, channels } = options.raw;
      const rgba = rawToRgba(toBuffer(input), width, height, channels);
      return new JimpSharpInstance(async () => ({
        data: rgba,
        width,
        height,
      }));
    }
    if (!input) {
      throw new Error("[sharp-compat] an input buffer is required");
    }
    const encoded = toBuffer(input);
    return new JimpSharpInstance(async () => {
      const img = await Jimp.read(encoded);
      return jimpToBitmap(img);
    });
  };
}

function toBuffer(input: Buffer | Uint8Array): Buffer {
  return Buffer.isBuffer(input) ? input : Buffer.from(input);
}

function bitmapToJimp(bitmap: Bitmap): JimpImage {
  return Jimp.fromBitmap({
    data: bitmap.data,
    width: bitmap.width,
    height: bitmap.height,
  });
}

function jimpToBitmap(img: JimpImage): Bitmap {
  const { data, width, height } = img.bitmap;
  return { data: Buffer.from(data), width, height };
}

/** True when any pixel has a non-opaque alpha channel. */
function hasAlphaPixels(bitmap: Bitmap): boolean {
  for (let i = 3; i < bitmap.data.length; i += 4) {
    if (bitmap.data[i] !== 255) return true;
  }
  return false;
}

/** Expand raw N-channel pixels to the RGBA bitmap jimp works in. */
function rawToRgba(
  data: Buffer,
  width: number,
  height: number,
  channels: number,
): Buffer {
  const pixels = width * height;
  const out = Buffer.allocUnsafe(pixels * 4);
  for (let p = 0; p < pixels; p++) {
    const src = p * channels;
    const dst = p * 4;
    if (channels >= 3) {
      out[dst] = data[src];
      out[dst + 1] = data[src + 1];
      out[dst + 2] = data[src + 2];
      out[dst + 3] = channels >= 4 ? data[src + 3] : 255;
    } else {
      // 1ch grayscale or 2ch gray+alpha.
      const gray = data[src];
      out[dst] = gray;
      out[dst + 1] = gray;
      out[dst + 2] = gray;
      out[dst + 3] = channels === 2 ? data[src + 1] : 255;
    }
  }
  return out;
}

/** Collapse the RGBA working bitmap to the requested raw channel count. */
function toRawChannels(bitmap: Bitmap, channels: 3 | 4): Buffer {
  const pixels = bitmap.width * bitmap.height;
  if (channels === 4) {
    return Buffer.from(bitmap.data.subarray(0, pixels * 4));
  }
  const out = Buffer.allocUnsafe(pixels * 3);
  for (let p = 0; p < pixels; p++) {
    out[p * 3] = bitmap.data[p * 4];
    out[p * 3 + 1] = bitmap.data[p * 4 + 1];
    out[p * 3 + 2] = bitmap.data[p * 4 + 2];
  }
  return out;
}

// --- PNG encoder -----------------------------------------------------------
//
// Minimal, dependency-free PNG encoder (filter type 0, single IDAT) backed by
// node's built-in zlib. Replaces jimp's PNG encoder, which produces corrupt
// output under Node 24/25. Color type 6 (RGBA) by default, color type 2 (RGB)
// when alpha was dropped.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.allocUnsafe(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.allocUnsafe(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

function encodePng(bitmap: Bitmap, dropAlpha: boolean): Buffer {
  const { width, height, data } = bitmap;
  const channels = dropAlpha ? 3 : 4;
  const stride = width * channels;
  // One filter byte (type 0 = none) per scanline, then the row pixels.
  const rawWithFilters = Buffer.allocUnsafe((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const dstRow = y * (stride + 1);
    rawWithFilters[dstRow] = 0;
    if (dropAlpha) {
      const srcRow = y * width * 4;
      for (let x = 0; x < width; x++) {
        const s = srcRow + x * 4;
        const d = dstRow + 1 + x * 3;
        rawWithFilters[d] = data[s];
        rawWithFilters[d + 1] = data[s + 1];
        rawWithFilters[d + 2] = data[s + 2];
      }
    } else {
      const srcRow = y * stride;
      data.copy(rawWithFilters, dstRow + 1, srcRow, srcRow + stride);
    }
  }

  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = dropAlpha ? 2 : 6; // color type: 2 = RGB, 6 = RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(rawWithFilters)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** Copy a sub-rectangle out of an RGBA bitmap (sharp `extract` semantics). */
function cropBitmap(bitmap: Bitmap, region: SharpExtractRegion): Bitmap {
  const { left, top, width, height } = region;
  const out = Buffer.allocUnsafe(width * height * 4);
  const srcStride = bitmap.width * 4;
  for (let y = 0; y < height; y++) {
    const srcRow = (top + y) * srcStride + left * 4;
    bitmap.data.copy(out, y * width * 4, srcRow, srcRow + width * 4);
  }
  return { data: out, width, height };
}

/** Pad a bitmap with a solid-color border (sharp `extend` semantics). */
function padBitmap(
  bitmap: Bitmap,
  top: number,
  bottom: number,
  left: number,
  right: number,
  bg: SharpColor,
): Bitmap {
  const newWidth = bitmap.width + left + right;
  const newHeight = bitmap.height + top + bottom;
  const out = Buffer.allocUnsafe(newWidth * newHeight * 4);
  const alpha = bg.alpha === undefined ? 255 : Math.round(bg.alpha * 255);
  for (let i = 0; i < out.length; i += 4) {
    out[i] = bg.r;
    out[i + 1] = bg.g;
    out[i + 2] = bg.b;
    out[i + 3] = alpha;
  }
  for (let y = 0; y < bitmap.height; y++) {
    const srcRow = y * bitmap.width * 4;
    const dstRow = ((y + top) * newWidth + left) * 4;
    bitmap.data.copy(out, dstRow, srcRow, srcRow + bitmap.width * 4);
  }
  return { data: out, width: newWidth, height: newHeight };
}

/**
 * Autocrop a uniform border (sharp `trim` default: trim pixels matching the
 * top-left corner color, full-tolerance equality).
 */
function trimBitmap(bitmap: Bitmap): Bitmap {
  const { data, width, height } = bitmap;
  const sameAsCorner = (x: number, y: number): boolean => {
    const i = (y * width + x) * 4;
    return (
      data[i] === data[0] &&
      data[i + 1] === data[1] &&
      data[i + 2] === data[2] &&
      data[i + 3] === data[3]
    );
  };
  let top = 0;
  let bottom = height - 1;
  let left = 0;
  let right = width - 1;
  const rowUniform = (y: number): boolean => {
    for (let x = 0; x < width; x++) if (!sameAsCorner(x, y)) return false;
    return true;
  };
  const colUniform = (x: number): boolean => {
    for (let y = 0; y < height; y++) if (!sameAsCorner(x, y)) return false;
    return true;
  };
  while (top < bottom && rowUniform(top)) top++;
  while (bottom > top && rowUniform(bottom)) bottom--;
  while (left < right && colUniform(left)) left++;
  while (right > left && colUniform(right)) right--;

  const newWidth = right - left + 1;
  const newHeight = bottom - top + 1;
  if (newWidth === width && newHeight === height) return bitmap;
  const out = Buffer.allocUnsafe(newWidth * newHeight * 4);
  for (let y = 0; y < newHeight; y++) {
    const srcRow = ((y + top) * width + left) * 4;
    out.set(data.subarray(srcRow, srcRow + newWidth * 4), y * newWidth * 4);
  }
  return { data: out, width: newWidth, height: newHeight };
}
