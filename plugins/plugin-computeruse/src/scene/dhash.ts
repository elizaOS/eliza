/**
 * Difference-hash (dHash) implementation for cheap frame-level and
 * block-level change detection in the WS6 scene-builder.
 *
 * Why dHash:
 *   - 64-bit integer, hammable in two cycles, vastly cheaper than a structural
 *     similarity index.
 *   - Robust to small re-encodings (cursor jitter, anti-alias seams) which
 *     dominate "no change" frames in a real session.
 *   - Tunable: we run an 8×8 whole-frame hash for the cheap "did anything
 *     happen?" gate, and a 16×16 block grid (each block ~128×128 of source)
 *     for dirty-block re-OCR.
 *
 * Implementation notes:
 *   - The PNG decoder here is intentionally minimal — it handles the formats
 *     produced by every screenshot path we ship (color type 2 = RGB, 6 =
 *     RGBA, 8-bit depth, non-interlaced). Anything else returns `null` and
 *     the caller falls back to a coarser whole-frame byte hash.
 *   - Pure functions, no I/O. Safe to test deterministically.
 *
 * Block-grid contract:
 *   - The image is gridded into N×N blocks (default 16) covering the whole
 *     frame; remainder pixels go to the right/bottom edges.
 *   - Each block gets its own 8-bit "mini-hash" derived from row-wise grayscale
 *     differences sampled at four points per block. Two blocks compare equal
 *     iff their hashes match. This is intentionally a much coarser test than
 *     a full per-block dHash — the goal is just "did this region change at
 *     all?" not "how similar."
 */

import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

export interface RawImage {
  width: number;
  height: number;
  /** RGBA scanline data, row-major, 4 bytes/pixel, length = width*height*4. */
  rgba: Buffer;
}

/**
 * Decode a PNG buffer to RGBA. Returns null for unsupported variants
 * (interlaced, palette-indexed, 16-bit depth) — caller handles that by
 * falling back to a non-block-grid hash strategy.
 */
export function decodePng(png: Buffer): RawImage | null {
  if (png.length < PNG_SIGNATURE.length) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (png[i] !== PNG_SIGNATURE[i]) return null;
  }
  let offset = PNG_SIGNATURE.length;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks: Buffer[] = [];

  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString("ascii");
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd > png.length) return null;
    if (type === "IHDR") {
      if (length < 13) return null;
      width = png.readUInt32BE(dataStart);
      height = png.readUInt32BE(dataStart + 4);
      bitDepth = png[dataStart + 8] ?? 0;
      colorType = png[dataStart + 9] ?? 0;
      interlace = png[dataStart + 12] ?? 0;
    } else if (type === "IDAT") {
      idatChunks.push(png.subarray(dataStart, dataEnd));
    } else if (type === "IEND") {
      break;
    }
    offset = dataEnd + 4; // skip CRC
  }

  if (width === 0 || height === 0) return null;
  if (bitDepth !== 8) return null;
  if (interlace !== 0) return null;
  if (colorType !== 2 && colorType !== 6) return null;
  if (idatChunks.length === 0) return null;

  const inflated = inflateSync(Buffer.concat(idatChunks));
  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const stride = width * bytesPerPixel;
  const expected = (stride + 1) * height;
  if (inflated.length < expected) return null;

  const rgba = Buffer.alloc(width * height * 4);
  const prevRow = Buffer.alloc(stride);
  const curRow = Buffer.alloc(stride);

  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    const filter = inflated[rowStart] ?? 0;
    const src = inflated.subarray(rowStart + 1, rowStart + 1 + stride);
    applyPngFilter(filter, src, prevRow, curRow, bytesPerPixel);
    const dstRowStart = y * width * 4;
    for (let x = 0; x < width; x += 1) {
      const sx = x * bytesPerPixel;
      const dx = dstRowStart + x * 4;
      rgba[dx] = curRow[sx] ?? 0;
      rgba[dx + 1] = curRow[sx + 1] ?? 0;
      rgba[dx + 2] = curRow[sx + 2] ?? 0;
      rgba[dx + 3] = bytesPerPixel === 4 ? (curRow[sx + 3] ?? 255) : 255;
    }
    curRow.copy(prevRow);
  }
  return { width, height, rgba };
}

function applyPngFilter(
  filter: number,
  src: Buffer,
  prev: Buffer,
  out: Buffer,
  bpp: number,
): void {
  const len = src.length;
  for (let i = 0; i < len; i += 1) {
    const raw = src[i] ?? 0;
    const left = i >= bpp ? (out[i - bpp] ?? 0) : 0;
    const up = prev[i] ?? 0;
    const upLeft = i >= bpp ? (prev[i - bpp] ?? 0) : 0;
    let recon = 0;
    switch (filter) {
      case 0:
        recon = raw;
        break;
      case 1:
        recon = raw + left;
        break;
      case 2:
        recon = raw + up;
        break;
      case 3:
        recon = raw + ((left + up) >>> 1);
        break;
      case 4:
        recon = raw + paeth(left, up, upLeft);
        break;
      default:
        recon = raw;
    }
    out[i] = recon & 0xff;
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Compute a luminance value (0..255) for an RGBA pixel using
 * Rec. 601 coefficients.
 */
function luminance(r: number, g: number, b: number): number {
  return (0.299 * r + 0.587 * g + 0.114 * b) | 0;
}

/**
 * Resample the image to a (cols+1) × rows grayscale grid using nearest-
 * neighbor sampling, then compare horizontal neighbors to form a (cols*rows)
 * bit hash. With cols=8, rows=8 this is the classic 64-bit dHash.
 */
function dhashGrid(image: RawImage, cols: number, rows: number): bigint {
  const { width, height, rgba } = image;
  const samples = new Uint8Array((cols + 1) * rows);
  for (let y = 0; y < rows; y += 1) {
    const sy = Math.min(height - 1, Math.floor((y * height) / rows));
    for (let x = 0; x <= cols; x += 1) {
      const sx = Math.min(width - 1, Math.floor((x * width) / (cols + 1)));
      const idx = (sy * width + sx) * 4;
      samples[y * (cols + 1) + x] = luminance(
        rgba[idx] ?? 0,
        rgba[idx + 1] ?? 0,
        rgba[idx + 2] ?? 0,
      );
    }
  }
  let hash = 0n;
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const a = samples[y * (cols + 1) + x] ?? 0;
      const b = samples[y * (cols + 1) + x + 1] ?? 0;
      hash = (hash << 1n) | (a > b ? 1n : 0n);
    }
  }
  return hash;
}

/**
 * 64-bit dHash of the whole frame. Returns `null` if the PNG can't be
 * decoded; callers fall back to a byte-length comparison.
 */
export function frameDhash(png: Buffer): bigint | null {
  const decoded = decodePng(png);
  if (!decoded) return null;
  return dhashGrid(decoded, 8, 8);
}

/**
 * Hamming distance between two 64-bit dHashes. Two visually identical frames
 * report 0. We treat anything < 5 as "no change" for the idle gate.
 */
export function hamming(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x !== 0n) {
    x &= x - 1n;
    count += 1;
  }
  return count;
}

export interface BlockGrid {
  /** Cols × Rows block-hash matrix. Index by `row * cols + col`. */
  hashes: Uint32Array;
  cols: number;
  rows: number;
}

/**
 * Split a frame into a `cols x rows` grid and return a tiny per-block hash.
 *
 * We don't use a full dHash per block — instead we sample 4 luminance points
 * per block and pack a 16-bit fingerprint. That's enough to spot "this block
 * changed" with very few false-negatives in practice, and stays cheap when
 * called every active-poll frame (4 Hz).
 */
export function blockGrid(
  png: Buffer,
  cols = 16,
  rows = 16,
): BlockGrid | null {
  const decoded = decodePng(png);
  if (!decoded) return null;
  return blockGridFromImage(decoded, cols, rows);
}

export function blockGridFromImage(
  image: RawImage,
  cols = 16,
  rows = 16,
): BlockGrid {
  const { width, height, rgba } = image;
  const hashes = new Uint32Array(cols * rows);
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const x0 = Math.floor((c * width) / cols);
      const x1 = Math.floor(((c + 1) * width) / cols);
      const y0 = Math.floor((r * height) / rows);
      const y1 = Math.floor(((r + 1) * height) / rows);
      const w = Math.max(1, x1 - x0);
      const h = Math.max(1, y1 - y0);
      // Four sample points: tl, tr, bl, br of the block interior.
      const samples = [
        sample(rgba, width, x0, y0),
        sample(rgba, width, x0 + w - 1, y0),
        sample(rgba, width, x0, y0 + h - 1),
        sample(rgba, width, x0 + w - 1, y0 + h - 1),
      ];
      // Pack four luminance values into 32 bits.
      const v0 = (samples[0] ?? 0) & 0xff;
      const v1 = (samples[1] ?? 0) & 0xff;
      const v2 = (samples[2] ?? 0) & 0xff;
      const v3 = (samples[3] ?? 0) & 0xff;
      hashes[r * cols + c] = ((v0 << 24) | (v1 << 16) | (v2 << 8) | v3) >>> 0;
    }
  }
  return { hashes, cols, rows };
}

function sample(rgba: Buffer, width: number, x: number, y: number): number {
  const idx = (y * width + x) * 4;
  return luminance(
    rgba[idx] ?? 0,
    rgba[idx + 1] ?? 0,
    rgba[idx + 2] ?? 0,
  );
}

export interface DirtyBlock {
  col: number;
  row: number;
  /** Pixel-space bbox `[x, y, w, h]` of this block in the source frame. */
  bbox: [number, number, number, number];
}

/**
 * Return the list of blocks whose hash changed between two grids.
 *
 * If `prev` is null (first frame) every block is dirty.
 * If `imageWidth/Height` are passed, the result includes a pixel-space bbox
 * for each dirty block so the caller can crop the source PNG to re-OCR only
 * the changed regions.
 */
export function diffBlocks(
  prev: BlockGrid | null,
  current: BlockGrid,
  imageWidth?: number,
  imageHeight?: number,
): DirtyBlock[] {
  const dirty: DirtyBlock[] = [];
  const { cols, rows } = current;
  for (let r = 0; r < rows; r += 1) {
    for (let c = 0; c < cols; c += 1) {
      const i = r * cols + c;
      const same =
        prev !== null && prev.cols === cols && prev.rows === rows
          ? prev.hashes[i] === current.hashes[i]
          : false;
      if (same) continue;
      const bbox: [number, number, number, number] =
        imageWidth !== undefined && imageHeight !== undefined
          ? [
              Math.floor((c * imageWidth) / cols),
              Math.floor((r * imageHeight) / rows),
              Math.max(1, Math.floor(((c + 1) * imageWidth) / cols) -
                Math.floor((c * imageWidth) / cols)),
              Math.max(1, Math.floor(((r + 1) * imageHeight) / rows) -
                Math.floor((r * imageHeight) / rows)),
            ]
          : [c, r, 1, 1];
      dirty.push({ col: c, row: r, bbox });
    }
  }
  return dirty;
}

/**
 * Coalesce a list of dirty blocks into axis-aligned rectangles using a row-
 * sweep merge. Adjacent dirty blocks in the same row collapse into a single
 * horizontal strip, then strips in successive rows that fully overlap collapse
 * vertically. This keeps the OS region-capture count tiny in the common case
 * where a single text field or a banner area changes (1 region, not 12).
 *
 * Returns the rectangles in display-local pixel space when `imageWidth` /
 * `imageHeight` are provided; otherwise in `col, row, colspan, rowspan`
 * units (1,1,1,1 = a single block at grid position 0,0).
 */
export function coalesceDirtyBlocks(
  dirty: DirtyBlock[],
  grid: BlockGrid,
  imageWidth?: number,
  imageHeight?: number,
): Array<{ bbox: [number, number, number, number] }> {
  if (dirty.length === 0) return [];
  // Build a sparse occupied set keyed by `${row}:${col}`.
  const occupied = new Set<string>();
  for (const b of dirty) occupied.add(`${b.row}:${b.col}`);

  // Row-sweep: merge horizontal runs first.
  const strips: Array<{ row: number; col0: number; col1: number }> = [];
  for (let r = 0; r < grid.rows; r += 1) {
    let c = 0;
    while (c < grid.cols) {
      if (!occupied.has(`${r}:${c}`)) {
        c += 1;
        continue;
      }
      let c1 = c;
      while (c1 + 1 < grid.cols && occupied.has(`${r}:${c1 + 1}`)) c1 += 1;
      strips.push({ row: r, col0: c, col1: c1 });
      c = c1 + 1;
    }
  }

  // Merge strips that share identical col extents in successive rows.
  const merged: Array<{ row0: number; row1: number; col0: number; col1: number }> = [];
  for (const strip of strips) {
    const last = merged[merged.length - 1];
    if (
      last &&
      last.col0 === strip.col0 &&
      last.col1 === strip.col1 &&
      last.row1 + 1 === strip.row
    ) {
      last.row1 = strip.row;
      continue;
    }
    merged.push({ row0: strip.row, row1: strip.row, col0: strip.col0, col1: strip.col1 });
  }

  return merged.map(({ row0, row1, col0, col1 }) => {
    if (imageWidth !== undefined && imageHeight !== undefined) {
      const x0 = Math.floor((col0 * imageWidth) / grid.cols);
      const y0 = Math.floor((row0 * imageHeight) / grid.rows);
      const x1 = Math.floor(((col1 + 1) * imageWidth) / grid.cols);
      const y1 = Math.floor(((row1 + 1) * imageHeight) / grid.rows);
      return {
        bbox: [x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)] as [
          number,
          number,
          number,
          number,
        ],
      };
    }
    return {
      bbox: [col0, row0, col1 - col0 + 1, row1 - row0 + 1] as [
        number,
        number,
        number,
        number,
      ],
    };
  });
}

/**
 * Read PNG dimensions without inflating IDAT. Cheap — only the IHDR chunk is
 * touched. Returns null if the buffer isn't a recognizable PNG.
 */
export function pngDimensions(png: Buffer): { width: number; height: number } | null {
  if (png.length < PNG_SIGNATURE.length + 8 + 13) return null;
  for (let i = 0; i < PNG_SIGNATURE.length; i += 1) {
    if (png[i] !== PNG_SIGNATURE[i]) return null;
  }
  // IHDR follows immediately after the signature: length(4) + "IHDR"(4) + width(4) + height(4) + ...
  const ihdrStart = PNG_SIGNATURE.length + 4;
  if (png.subarray(ihdrStart, ihdrStart + 4).toString("ascii") !== "IHDR") return null;
  const width = png.readUInt32BE(ihdrStart + 4);
  const height = png.readUInt32BE(ihdrStart + 8);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return null;
  }
  return { width, height };
}
