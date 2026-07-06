/**
 * Colour analyzers over screenshots and keyframes. `color.palette` ports the
 * dominant-k quantized palette from `packages/app/scripts/lib/visual-qa.mjs`.
 * `color.corners` samples the four corners plus the centre — the regions a
 * whole-frame palette washes out — to catch wrong-theme bleed, unstyled
 * corners, and dark/light-mode leaks, reporting each swatch's average RGB and
 * its nearest named bucket via the shared brand colour math.
 */

import sharp from "sharp";
import { type ColorBucket, classifyColor, round4 } from "./color-math.ts";
import type { Analyzer, AnalyzerFragment, AnalyzerInput } from "./types.ts";

/** One entry of the dominant-palette result. */
export interface PaletteSwatch {
  hex: string;
  rgb: [number, number, number];
  fraction: number;
}

/** Payload of a `ran` `color.palette` result. */
export interface PaletteData {
  swatches: PaletteSwatch[];
}

/**
 * Top-k colours by area from a downscaled, 4-bit-per-channel quantized
 * thumbnail. Ported verbatim from visual-qa.mjs so the palette numbers match
 * the existing gate.
 */
export async function dominantPalette(
  imagePath: string,
  k = 6,
): Promise<PaletteSwatch[]> {
  const { data, info } = await sharp(imagePath)
    .resize(160, 160, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const buckets = new Map<number, number>();
  const step = info.channels;
  for (let i = 0; i < data.length; i += step) {
    const r = data[i] & 0xf0;
    const g = data[i + 1] & 0xf0;
    const b = data[i + 2] & 0xf0;
    const key = (r << 16) | (g << 8) | b;
    buckets.set(key, (buckets.get(key) ?? 0) + 1);
  }
  const total = info.width * info.height || 1;
  return [...buckets.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([key, count]) => {
      const r = (key >> 16) & 0xff;
      const g = (key >> 8) & 0xff;
      const b = key & 0xff;
      return {
        hex: `#${hex2(r)}${hex2(g)}${hex2(b)}`,
        rgb: [r, g, b] as [number, number, number],
        fraction: round4(count / total),
      };
    });
}

export const colorPaletteAnalyzer: Analyzer = {
  name: "color.palette",
  tier: "cpu",
  kinds: ["screenshot", "keyframe"],
  async analyze(input: AnalyzerInput): Promise<AnalyzerFragment> {
    const swatches = await dominantPalette(input.absolutePath);
    const data: PaletteData = { swatches };
    return { status: "ran", data };
  },
};

/** The five swatch positions `color.corners` samples. */
export const CORNER_POSITIONS = [
  "top-left",
  "top-right",
  "bottom-left",
  "bottom-right",
  "center",
] as const;
export type CornerPosition = (typeof CORNER_POSITIONS)[number];

/** One sampled swatch: average colour and its nearest named bucket. */
export interface CornerSwatch {
  position: CornerPosition;
  rgb: [number, number, number];
  hex: string;
  bucket: ColorBucket;
}

/** Payload of a `ran` `color.corners` result. */
export interface CornersData {
  swatches: CornerSwatch[];
}

/** Fraction of the shorter frame dimension a swatch spans (min 8px). */
const SWATCH_FRACTION = 0.12;

/** Mean RGB of a raw RGB(A) buffer. */
function meanRgb(
  data: Uint8Array | Buffer,
  channels: number,
): [number, number, number] {
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let i = 0; i < data.length; i += channels) {
    r += data[i];
    g += data[i + 1];
    b += data[i + 2];
    n++;
  }
  n = n || 1;
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

/**
 * Sample the four corners and centre, averaging each swatch's raw pixels and
 * classifying the mean with the shared brand math. The swatch is extracted to a
 * raw buffer and averaged in JS rather than via `sharp().extract().stats()`:
 * stats in that chained form reports over the whole source image, not the
 * extracted region, so it would silently sample the entire frame. Swatch size
 * is a fraction of the frame so it scales with resolution; a floor keeps it
 * meaningful on tiny keyframes.
 */
export async function cornerSwatches(
  imagePath: string,
): Promise<CornerSwatch[]> {
  const meta = await sharp(imagePath).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (width < 2 || height < 2) {
    throw new Error(`image too small to sample corners: ${width}x${height}`);
  }
  const size = Math.max(
    8,
    Math.round(Math.min(width, height) * SWATCH_FRACTION),
  );
  const w = Math.min(size, width);
  const h = Math.min(size, height);
  const boxes: Record<CornerPosition, { left: number; top: number }> = {
    "top-left": { left: 0, top: 0 },
    "top-right": { left: width - w, top: 0 },
    "bottom-left": { left: 0, top: height - h },
    "bottom-right": { left: width - w, top: height - h },
    center: {
      left: Math.floor((width - w) / 2),
      top: Math.floor((height - h) / 2),
    },
  };
  const swatches: CornerSwatch[] = [];
  for (const position of CORNER_POSITIONS) {
    const { left, top } = boxes[position];
    // Re-open the source per extract: sharp instances are single-use pipelines.
    const { data, info } = await sharp(imagePath)
      .extract({ left, top, width: w, height: h })
      .raw()
      .toBuffer({ resolveWithObject: true });
    const [r, g, b] = meanRgb(data, info.channels);
    swatches.push({
      position,
      rgb: [r, g, b],
      hex: `#${hex2(r)}${hex2(g)}${hex2(b)}`,
      bucket: classifyColor(r, g, b),
    });
  }
  return swatches;
}

export const colorCornersAnalyzer: Analyzer = {
  name: "color.corners",
  tier: "cpu",
  kinds: ["screenshot", "keyframe"],
  async analyze(input: AnalyzerInput): Promise<AnalyzerFragment> {
    const swatches = await cornerSwatches(input.absolutePath);
    const data: CornersData = { swatches };
    return { status: "ran", data };
  },
};

function hex2(value: number): string {
  return value.toString(16).padStart(2, "0");
}
