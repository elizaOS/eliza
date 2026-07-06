/**
 * Before/after diff analyzers. `diff.change` ports the size-agnostic
 * change-metric from `packages/app/scripts/lib/visual-qa.mjs`: resize both
 * frames onto a common 256px-wide grid and count max-channel deltas over a
 * threshold, returning the changed fraction and a single bounding box.
 * `diff.region` is the finer instrument — pixelmatch on a dimension-matched
 * before/after, changed pixels clustered into bounding boxes on a coarse grid,
 * with optional per-region expectations (a region expected to change, or
 * expected to stay static) evaluated to pass/fail assertions.
 *
 * Baselines come from `ctx.baselineResolver` — this analyzer hardcodes no
 * baseline directory. When no baseline resolves (first run, new subject) the
 * analyzer records `skipped-missing-tool` with that reason, never a fabricated
 * zero-change result.
 */

import pixelmatch from "pixelmatch";
import sharp from "sharp";
import { EvidenceError } from "../errors.ts";
import { round4 } from "./color-math.ts";
import type {
  Analyzer,
  AnalyzerContext,
  AnalyzerFragment,
  AnalyzerInput,
  RegionExpectation,
} from "./types.ts";

// --- diff.change (ported size-agnostic metric) -----------------------------

/** Payload of a `ran` `diff.change` result. */
export interface ChangeData {
  changed_fraction: number;
  /** `[minX, minY, maxX, maxY]` on the compare grid, or null when unchanged. */
  changed_bbox: [number, number, number, number] | null;
  grid: [number, number];
}

/** Max-channel-delta change metric over a common grid (ported behaviour). */
export async function changeMetric(
  imagePath: string,
  baselinePath: string,
): Promise<ChangeData> {
  const width = 256;
  const meta = await sharp(imagePath).metadata();
  const srcW = meta.width ?? width;
  const srcH = meta.height ?? width;
  const height = Math.max(1, Math.round((width * srcH) / srcW));
  const toGrid = (src: string) =>
    sharp(src)
      .resize(width, height, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer();
  const [a, b] = await Promise.all([toGrid(imagePath), toGrid(baselinePath)]);
  let changed = 0;
  let minX = width;
  let minY = height;
  let maxX = 0;
  let maxY = 0;
  const px = width * height;
  for (let p = 0; p < px; p++) {
    const i = p * 3;
    const d = Math.max(
      Math.abs(a[i] - b[i]),
      Math.abs(a[i + 1] - b[i + 1]),
      Math.abs(a[i + 2] - b[i + 2]),
    );
    if (d > 24) {
      changed++;
      const x = p % width;
      const y = (p / width) | 0;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return {
    changed_fraction: round4(changed / px),
    changed_bbox: changed ? [minX, minY, maxX, maxY] : null,
    grid: [width, height],
  };
}

export const diffChangeAnalyzer: Analyzer = {
  name: "diff.change",
  tier: "cpu",
  kinds: ["screenshot", "keyframe"],
  async analyze(
    input: AnalyzerInput,
    ctx: AnalyzerContext,
  ): Promise<AnalyzerFragment> {
    const baseline = await resolveBaseline(input, ctx);
    if (!baseline.ok) return baseline.fragment;
    const data = await changeMetric(input.absolutePath, baseline.path);
    return { status: "ran", data };
  },
};

// --- diff.region (pixelmatch + clustering + expectations) ------------------

/** A changed-pixel cluster as a normalized bounding box. */
export interface ChangedRegion {
  /** Normalized [0,1] coordinates relative to the compared grid. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Fraction of the whole frame this region's changed pixels cover. */
  fraction: number;
}

/** Result of one region expectation assertion. */
export interface RegionAssertion {
  label: string;
  kind: "change" | "static";
  ok: boolean;
  /** Fraction of the expected region's pixels that changed. */
  observed_fraction: number;
}

/** Payload of a `ran` `diff.region` result. */
export interface RegionDiffData {
  changed_fraction: number;
  grid: [number, number];
  regions: ChangedRegion[];
  assertions: RegionAssertion[];
}

/**
 * pixelmatch on the max common grid; returns the boolean per-pixel changed mask
 * plus the grid dims. Both frames are resized to the smaller of the two so
 * dimension mismatch never throws (the ported metric already resizes; region
 * diff matches its resolution-independence).
 */
async function changedMask(
  imagePath: string,
  baselinePath: string,
  threshold: number,
): Promise<{ mask: Uint8Array; width: number; height: number }> {
  const [metaA, metaB] = await Promise.all([
    sharp(imagePath).metadata(),
    sharp(baselinePath).metadata(),
  ]);
  const width = Math.min(metaA.width ?? 0, metaB.width ?? 0) || 256;
  const height = Math.min(metaA.height ?? 0, metaB.height ?? 0) || 256;
  const toRgba = (src: string) =>
    sharp(src)
      .resize(width, height, { fit: "fill" })
      .ensureAlpha()
      .raw()
      .toBuffer();
  const [a, b] = await Promise.all([toRgba(imagePath), toRgba(baselinePath)]);
  const diff = new Uint8Array(width * height * 4);
  pixelmatch(a, b, diff, width, height, { threshold });
  // pixelmatch writes red (255,0,0) at changed pixels on a light background;
  // any non-transparent red pixel in the mask marks a change.
  const mask = new Uint8Array(width * height);
  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    mask[p] = diff[i] > 200 && diff[i + 1] < 80 && diff[i + 2] < 80 ? 1 : 0;
  }
  return { mask, width, height };
}

/**
 * Cluster changed-mask pixels into bounding boxes on a coarse cell grid, then
 * union adjacent occupied cells with flood fill. Deliberately dumb and
 * deterministic — cell size is a fixed fraction of the frame so a contiguous
 * changed rectangle yields one box regardless of resolution.
 */
export function clusterRegions(
  mask: Uint8Array,
  width: number,
  height: number,
  cells = 32,
): ChangedRegion[] {
  const cellW = Math.max(1, Math.ceil(width / cells));
  const cellH = Math.max(1, Math.ceil(height / cells));
  const cols = Math.ceil(width / cellW);
  const rows = Math.ceil(height / cellH);
  // Count changed pixels per cell; a cell is "occupied" if any pixel changed.
  const cellCount = new Int32Array(cols * rows);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (mask[y * width + x] === 1) {
        const cx = (x / cellW) | 0;
        const cy = (y / cellH) | 0;
        cellCount[cy * cols + cx]++;
      }
    }
  }
  const totalPixels = width * height;
  const visited = new Uint8Array(cols * rows);
  const regions: ChangedRegion[] = [];
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const idx = cy * cols + cx;
      if (cellCount[idx] === 0 || visited[idx] === 1) continue;
      // Flood-fill occupied 4-neighbours into one region.
      let minCx = cx;
      let minCy = cy;
      let maxCx = cx;
      let maxCy = cy;
      let changedPixels = 0;
      const stack = [idx];
      visited[idx] = 1;
      while (stack.length > 0) {
        const cur = stack.pop() as number;
        const ux = cur % cols;
        const uy = (cur / cols) | 0;
        changedPixels += cellCount[cur];
        if (ux < minCx) minCx = ux;
        if (uy < minCy) minCy = uy;
        if (ux > maxCx) maxCx = ux;
        if (uy > maxCy) maxCy = uy;
        for (const [dx, dy] of NEIGHBOURS) {
          const nx = ux + dx;
          const ny = uy + dy;
          if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
          const nIdx = ny * cols + nx;
          if (cellCount[nIdx] > 0 && visited[nIdx] === 0) {
            visited[nIdx] = 1;
            stack.push(nIdx);
          }
        }
      }
      const boxLeft = minCx * cellW;
      const boxTop = minCy * cellH;
      const boxRight = Math.min(width, (maxCx + 1) * cellW);
      const boxBottom = Math.min(height, (maxCy + 1) * cellH);
      regions.push({
        x: round4(boxLeft / width),
        y: round4(boxTop / height),
        w: round4((boxRight - boxLeft) / width),
        h: round4((boxBottom - boxTop) / height),
        fraction: round4(changedPixels / totalPixels),
      });
    }
  }
  return regions.sort((a, b) => b.fraction - a.fraction);
}

const NEIGHBOURS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

/**
 * Reject a malformed caller-supplied expectation region. Regions are declared
 * in normalized [0,1] coordinates; an out-of-range or degenerate box would
 * silently sample the wrong pixels (or none), turning a config typo into a
 * confidently wrong pass/fail — so it fails the analyzer loudly instead.
 */
function assertValidRegion(exp: RegionExpectation, index: number): void {
  const { x, y, w, h } = exp.region;
  const valid =
    [x, y, w, h].every((value) => Number.isFinite(value)) &&
    x >= 0 &&
    y >= 0 &&
    w > 0 &&
    h > 0 &&
    x + w <= 1 &&
    y + h <= 1;
  if (!valid) {
    throw new EvidenceError(
      `region expectation '${exp.label ?? `${exp.kind}#${index}`}' has an invalid normalized box ` +
        `{x:${x}, y:${y}, w:${w}, h:${h}} — expected 0<=x,y and w,h>0 with x+w<=1, y+h<=1`,
      { code: "REGION_EXPECTATION_INVALID", context: { region: exp.region } },
    );
  }
}

/**
 * Evaluate per-region expectations against the changed mask. A `change` region
 * passes when a meaningful fraction of its pixels changed; a `static` region
 * passes when almost none did. The 1% threshold tolerates antialiasing without
 * masking a real change.
 */
export function evaluateRegionExpectations(
  mask: Uint8Array,
  width: number,
  height: number,
  expectations: RegionExpectation[],
): RegionAssertion[] {
  const CHANGE_FLOOR = 0.01;
  return expectations.map((exp, index) => {
    assertValidRegion(exp, index);
    const left = Math.round(exp.region.x * width);
    const top = Math.round(exp.region.y * height);
    const right = Math.min(
      width,
      Math.round((exp.region.x + exp.region.w) * width),
    );
    const bottom = Math.min(
      height,
      Math.round((exp.region.y + exp.region.h) * height),
    );
    let changed = 0;
    let total = 0;
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        total++;
        if (mask[y * width + x] === 1) changed++;
      }
    }
    const observed = total > 0 ? changed / total : 0;
    const ok =
      exp.kind === "change"
        ? observed >= CHANGE_FLOOR
        : observed < CHANGE_FLOOR;
    return {
      label: exp.label ?? `${exp.kind}#${index}`,
      kind: exp.kind,
      ok,
      observed_fraction: round4(observed),
    };
  });
}

export const diffRegionAnalyzer: Analyzer = {
  name: "diff.region",
  tier: "cpu",
  kinds: ["screenshot", "keyframe"],
  async analyze(
    input: AnalyzerInput,
    ctx: AnalyzerContext,
  ): Promise<AnalyzerFragment> {
    const baseline = await resolveBaseline(input, ctx);
    if (!baseline.ok) return baseline.fragment;
    const { mask, width, height } = await changedMask(
      input.absolutePath,
      baseline.path,
      0.1,
    );
    let changed = 0;
    for (let i = 0; i < mask.length; i++) changed += mask[i];
    const regions = clusterRegions(mask, width, height);
    const expectedRegions = ctx.expectations?.[input.entry.path]?.regions ?? [];
    const assertions = evaluateRegionExpectations(
      mask,
      width,
      height,
      expectedRegions,
    );
    const data: RegionDiffData = {
      changed_fraction: round4(changed / (width * height)),
      grid: [width, height],
      regions,
      assertions,
    };
    return { status: "ran", data };
  },
};

/** Resolve a baseline path via the context resolver, or a skip fragment. */
async function resolveBaseline(
  input: AnalyzerInput,
  ctx: AnalyzerContext,
): Promise<
  { ok: true; path: string } | { ok: false; fragment: AnalyzerFragment }
> {
  if (!ctx.baselineResolver) {
    return {
      ok: false,
      fragment: {
        status: "skipped-missing-tool",
        reason: "no baselineResolver provided",
      },
    };
  }
  const path = await ctx.baselineResolver(input);
  if (!path) {
    return {
      ok: false,
      fragment: {
        status: "skipped-missing-tool",
        reason: "no baseline available for this subject",
      },
    };
  }
  return { ok: true, path };
}
