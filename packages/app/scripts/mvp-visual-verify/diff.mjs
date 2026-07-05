/**
 * Pixel diff of a captured screenshot against a committed baseline, with zero
 * new dependencies — sharp decodes both PNGs to raw RGBA and the comparison is
 * hand-rolled (pixelmatch is deliberately not installed).
 *
 * {@link summarizeDiff} is a pure reducer over pre-counted totals (unit-tested);
 * {@link diffAgainstBaseline} is the sharp-backed pipeline that decodes both
 * images, resizes the current shot to the baseline's dimensions when they drift
 * (fixed-viewport screenshots make this rare, but a resized DOM must not throw),
 * counts changed pixels, and writes a magenta-highlighted diff PNG. A first run
 * with no baseline records the baseline and reports status `"new"` — never a
 * false 0%-changed pass.
 */

import { mkdir } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

/** Per-channel sum-abs delta above which a pixel counts as changed. */
export const DEFAULT_PIXEL_THRESHOLD = 30;

/**
 * Reduce raw change counts into a diff summary. Pure so the percentage/verdict
 * math is unit-tested without decoding an image.
 *
 * @param {{ changedPixels: number, totalPixels: number, sumAbsDelta: number, resized?: boolean }} m
 * @returns {{ changedPixels: number, totalPixels: number, changedRatio: number, changedPercent: number, meanAbsDelta: number, resized: boolean }}
 */
export function summarizeDiff(m) {
  if (m.totalPixels <= 0) {
    throw new Error("summarizeDiff: totalPixels must be > 0");
  }
  const changedRatio = m.changedPixels / m.totalPixels;
  return {
    changedPixels: m.changedPixels,
    totalPixels: m.totalPixels,
    changedRatio,
    changedPercent: Number((changedRatio * 100).toFixed(3)),
    // meanAbsDelta is per-CHANNEL (sumAbsDelta already sums the 3 channels of
    // every pixel), giving a continuous signal even when no pixel trips the
    // threshold — a whole-image tint shift shows here before it shows in %.
    meanAbsDelta: Number((m.sumAbsDelta / (m.totalPixels * 3)).toFixed(3)),
    resized: Boolean(m.resized),
  };
}

/**
 * Compare two decoded RGBA buffers of identical dimensions. Pure over buffers so
 * a test can feed synthetic pixels. Returns the counts {@link summarizeDiff}
 * consumes plus an optional highlighted RGBA buffer (changed pixels → magenta,
 * unchanged → dimmed grayscale) for encoding.
 *
 * @param {Uint8Array|Buffer} a
 * @param {Uint8Array|Buffer} b
 * @param {number} width
 * @param {number} height
 * @param {{ threshold?: number, buildHighlight?: boolean }} [opts]
 */
export function comparePixels(a, b, width, height, opts = {}) {
  const threshold = opts.threshold ?? DEFAULT_PIXEL_THRESHOLD;
  const totalPixels = width * height;
  const expected = totalPixels * 4;
  if (a.length < expected || b.length < expected) {
    throw new Error(
      `comparePixels: buffers too small for ${width}x${height} (need ${expected}, got ${a.length}/${b.length})`,
    );
  }
  const highlight = opts.buildHighlight ? Buffer.alloc(expected) : null;
  let changedPixels = 0;
  let sumAbsDelta = 0;
  for (let p = 0, i = 0; p < totalPixels; p += 1, i += 4) {
    const dr = Math.abs(a[i] - b[i]);
    const dg = Math.abs(a[i + 1] - b[i + 1]);
    const db = Math.abs(a[i + 2] - b[i + 2]);
    const sum = dr + dg + db;
    sumAbsDelta += sum;
    const changed = sum > threshold;
    if (changed) changedPixels += 1;
    if (highlight) {
      if (changed) {
        highlight[i] = 255;
        highlight[i + 1] = 0;
        highlight[i + 2] = 255;
        highlight[i + 3] = 255;
      } else {
        const gray = Math.round((b[i] + b[i + 1] + b[i + 2]) / 3 / 3) + 20;
        highlight[i] = gray;
        highlight[i + 1] = gray;
        highlight[i + 2] = gray;
        highlight[i + 3] = 255;
      }
    }
  }
  return { changedPixels, totalPixels, sumAbsDelta, highlight };
}

/**
 * Decode current + baseline PNGs, diff them, and (when changed) write a diff PNG.
 * When no baseline exists yet the current shot is copied in as the baseline and
 * the result is `status: "new"` — honest "recorded, nothing to compare" rather
 * than a fabricated pass.
 *
 * @param {{ currentPath: string, baselinePath: string, diffOutPath?: string, threshold?: number, recordMissingBaseline?: boolean }} args
 * @returns {Promise<{ status: "new" | "compared", summary?: object, baselinePath: string, diffPath?: string }>}
 */
export async function diffAgainstBaseline(args) {
  const { currentPath, baselinePath } = args;
  const threshold = args.threshold ?? DEFAULT_PIXEL_THRESHOLD;
  const recordMissing = args.recordMissingBaseline ?? true;

  const baselineExists = await fileExists(baselinePath);
  if (!baselineExists) {
    if (recordMissing) {
      await mkdir(path.dirname(baselinePath), { recursive: true });
      await sharp(currentPath).toFile(baselinePath);
    }
    return { status: "new", baselinePath };
  }

  const baseline = await sharp(baselinePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const width = baseline.info.width;
  const height = baseline.info.height;

  let currentPipeline = sharp(currentPath).ensureAlpha();
  const currentMeta = await sharp(currentPath).metadata();
  const resized = currentMeta.width !== width || currentMeta.height !== height;
  if (resized) {
    currentPipeline = currentPipeline.resize(width, height, { fit: "fill" });
  }
  const current = await currentPipeline
    .raw()
    .toBuffer({ resolveWithObject: true });

  const wantHighlight = Boolean(args.diffOutPath);
  const cmp = comparePixels(current.data, baseline.data, width, height, {
    threshold,
    buildHighlight: wantHighlight,
  });
  const summary = summarizeDiff({
    changedPixels: cmp.changedPixels,
    totalPixels: cmp.totalPixels,
    sumAbsDelta: cmp.sumAbsDelta,
    resized,
  });

  let diffPath;
  if (wantHighlight && cmp.highlight && cmp.changedPixels > 0) {
    await mkdir(path.dirname(args.diffOutPath), { recursive: true });
    await sharp(cmp.highlight, { raw: { width, height, channels: 4 } })
      .png()
      .toFile(args.diffOutPath);
    diffPath = args.diffOutPath;
  }

  return { status: "compared", summary, baselinePath, diffPath };
}

async function fileExists(p) {
  const { access } = await import("node:fs/promises");
  return access(p).then(
    () => true,
    () => false,
  );
}
