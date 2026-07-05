/**
 * Dominant-color palette extraction for captured audit screenshots.
 *
 * Two tiers: {@link quantizePalette} is a pure function over a raw RGBA byte
 * buffer (bucket each channel to a coarse grid, tally coverage, return the top-K
 * swatches with brand-bucket labels) and is unit-tested with synthetic buffers;
 * {@link dominantColorsFromPng} is the sharp-backed decode wrapper the
 * post-processor calls on real PNGs. The palette feeds the accent-color
 * expectation (brand orange present, zero blue) — hence each swatch carries its
 * {@link bucketRgb} label so the expectation evaluator never re-classifies.
 */

import sharp from "sharp";
import { bucketRgb } from "./color-bucket.mjs";

/**
 * Quantize a raw RGBA buffer into the top-K dominant colors by coverage.
 *
 * Channels are snapped to a `step`-sized grid (default 16 → 16 levels/channel)
 * so near-identical anti-aliased pixels collapse into one bucket; fully
 * transparent pixels are skipped. Returns swatches sorted by descending coverage
 * with the representative (bucket-center) RGB, the fraction of opaque pixels, and
 * the brand bucket label.
 *
 * @param {Uint8Array|Buffer} data RGBA bytes, length = width*height*4.
 * @param {{ step?: number, topK?: number }} [opts]
 * @returns {{ swatches: Array<{ rgb: [number,number,number], hex: string, ratio: number, count: number, bucket: string }>, totalOpaque: number, buckets: Record<string, number> }}
 */
export function quantizePalette(data, opts = {}) {
  const step = opts.step ?? 16;
  const topK = opts.topK ?? 6;
  if (data.length % 4 !== 0) {
    throw new Error(
      `quantizePalette: RGBA buffer length ${data.length} is not a multiple of 4`,
    );
  }
  /** @type {Map<number, { r: number, g: number, b: number, count: number }>} */
  const bins = new Map();
  let totalOpaque = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 0) continue;
    totalOpaque += 1;
    // Snap to the grid CENTER (not the floor) so a bucket's representative color
    // sits mid-cell — closer to the true average of the pixels it absorbs.
    const half = Math.floor(step / 2);
    const r = Math.min(255, Math.floor(data[i] / step) * step + half);
    const g = Math.min(255, Math.floor(data[i + 1] / step) * step + half);
    const b = Math.min(255, Math.floor(data[i + 2] / step) * step + half);
    const key = (r << 16) | (g << 8) | b;
    const bin = bins.get(key);
    if (bin) bin.count += 1;
    else bins.set(key, { r, g, b, count: 1 });
  }
  const sorted = [...bins.values()].sort((x, y) => y.count - x.count);
  const denom = totalOpaque || 1;
  const swatches = sorted.slice(0, topK).map((bin) => ({
    rgb: /** @type {[number,number,number]} */ ([bin.r, bin.g, bin.b]),
    hex: rgbToHex(bin.r, bin.g, bin.b),
    ratio: bin.count / denom,
    count: bin.count,
    bucket: bucketRgb(bin.r, bin.g, bin.b),
  }));
  /** @type {Record<string, number>} */
  const buckets = {};
  for (const bin of bins.values()) {
    const label = bucketRgb(bin.r, bin.g, bin.b);
    buckets[label] = (buckets[label] ?? 0) + bin.count / denom;
  }
  return { swatches, totalOpaque, buckets };
}

/**
 * Decode a PNG to a downscaled raw RGBA buffer and return its dominant palette.
 * Downscaling (default longest edge 256px) is a speed/robustness trade: exact
 * per-pixel color counts are not the goal, dominant coverage is, and it keeps a
 * 1440×1000 shot to a few hundred KB of pixels.
 *
 * @param {string} pngPath
 * @param {{ step?: number, topK?: number, maxEdge?: number }} [opts]
 */
export async function dominantColorsFromPng(pngPath, opts = {}) {
  const maxEdge = opts.maxEdge ?? 256;
  const { data, info } = await sharp(pngPath)
    .resize({
      width: maxEdge,
      height: maxEdge,
      fit: "inside",
      withoutEnlargement: true,
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const palette = quantizePalette(data, opts);
  return { ...palette, sampledWidth: info.width, sampledHeight: info.height };
}

function rgbToHex(r, g, b) {
  const h = (n) => n.toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}
