/**
 * Shared visual-review primitives for screenshot evidence tools.
 *
 * These functions are deliberately Node-loadable `.mjs` rather than TypeScript:
 * several evidence CLIs run with plain `node` during capture, while the package's
 * primary TypeScript export is consumed by Bun/Vite/tsgo. Keeping OCR, palette,
 * brand buckets, pixel diffs, and expectation evaluation here gives those CLIs
 * one runtime-compatible source of truth without changing their scope or output
 * formats.
 */

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";

export const DEFAULT_PIXEL_THRESHOLD = 30;
export const DEFAULT_BLUE_COVERAGE_LIMIT = 0.05;
export const DEFAULT_ORANGE_COVERAGE_MIN = 0.0005;
export const DEFAULT_OVERFLOW_TOLERANCE_PX = 2;

const TESSERACT_JS_PACKAGE = "tesseract.js";
const TESSERACT_JS_CACHE_DIR = path.join(tmpdir(), "elizaos-tesseract-cache");
export const DEFAULT_OCR_CONFIDENCE_FLOOR = 0.45;
const OCR_FALLBACK_MAX_WIDTH = 2400;
const OCR_FALLBACK_SCALE = 3;
const OCR_FALLBACK_THRESHOLD = 225;
const PROVEN_BLANK_IMAGE_ISSUES = new Set([
  "screenshot has no sampled pixels",
  "screenshot is one color",
]);

/** @type {{ path: string | null } | null} */
let systemTesseractProbe = null;
/** @type {Promise<any> | null} */
let packagedTesseractProbe = null;
/** @type {Map<string, Promise<any>>} */
let packagedWorkers = new Map();

/**
 * Parse a CSS `rgb()` / `rgba()` string into `[r, g, b, a]`, or null.
 *
 * @param {string} input
 * @returns {[number, number, number, number] | null}
 */
export function parseRgb(input) {
  const m = String(input).match(
    /^rgba?\(\s*(\d+\.?\d*)\s*,\s*(\d+\.?\d*)\s*,\s*(\d+\.?\d*)(?:\s*,\s*(\d+\.?\d*))?\s*\)$/,
  );
  if (!m) return null;
  return [
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    m[4] === undefined ? 1 : Number(m[4]),
  ];
}

/**
 * Bucket an RGB triple into the app audit's coarse brand categories.
 *
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @param {number} [a=1]
 * @returns {"orange"|"black"|"blue"|"white"|"neutral"|"transparent"}
 */
export function bucketRgb(r, g, b, a = 1) {
  if (a === 0) return "transparent";
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const saturation = max === 0 ? 0 : chroma / max;

  if (lum > 0.95 && saturation < 0.05) return "white";
  if (saturation < 0.15 || chroma < 12) return lum < 0.08 ? "black" : "neutral";

  let hue = 0;
  if (chroma > 0) {
    if (max === r) hue = ((g - b) / chroma) % 6;
    else if (max === g) hue = (b - r) / chroma + 2;
    else hue = (r - g) / chroma + 4;
    hue *= 60;
    if (hue < 0) hue += 360;
  }
  if (hue >= 200 && hue <= 270) return "blue";
  if (hue >= 10 && hue <= 50) return "orange";
  if (lum < 0.08) return "black";
  return "neutral";
}

/**
 * Bucket a computed CSS color string into a coarse brand category.
 *
 * @param {string} color
 */
export function bucket(color) {
  const rgb = parseRgb(color);
  if (!rgb) return "neutral";
  return bucketRgb(rgb[0], rgb[1], rgb[2], rgb[3]);
}

/**
 * Quantize a raw RGBA buffer into dominant colors by coverage.
 *
 * @param {Uint8Array|Buffer} data
 * @param {{ step?: number, topK?: number }} [opts]
 */
export function quantizePalette(data, opts = {}) {
  const step = opts.step ?? 16;
  const topK = opts.topK ?? 6;
  if (data.length % 4 !== 0) {
    throw new Error(
      `quantizePalette: RGBA buffer length ${data.length} is not a multiple of 4`,
    );
  }
  const bins = new Map();
  let totalOpaque = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a === 0) continue;
    totalOpaque += 1;
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
    rgb: [bin.r, bin.g, bin.b],
    hex: rgbToHex(bin.r, bin.g, bin.b),
    ratio: bin.count / denom,
    count: bin.count,
    bucket: bucketRgb(bin.r, bin.g, bin.b),
  }));
  const buckets = {};
  for (const bin of bins.values()) {
    const label = bucketRgb(bin.r, bin.g, bin.b);
    buckets[label] = (buckets[label] ?? 0) + bin.count / denom;
  }
  return { swatches, totalOpaque, buckets };
}

/** Decode an image and return the MVP verifier's dominant palette shape. */
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

/** Top-k colours by area, using the legacy visual-qa 4-bit floor quantizer. */
export async function dominantPalette(imagePath, k = 6) {
  const { data, info } = await sharp(imagePath)
    .resize(160, 160, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const buckets = new Map();
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
        hex: rgbToHex(r, g, b),
        rgb: [r, g, b],
        fraction: Number((count / total).toFixed(4)),
      };
    });
}

/** Whole-frame blue/orange/neutral fractions used by the app brand gate. */
export async function brandColorFractionsFromPng(imagePath) {
  const { data, info } = await sharp(imagePath)
    .resize(200, 200, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const step = info.channels;
  const n = data.length / step || 1;
  let blue = 0;
  let orange = 0;
  let neutral = 0;
  for (let i = 0; i < data.length; i += step) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    if (b > r + 30 && b > g + 30 && b > 90) blue++;
    if (r > 150 && r > g + 25 && g > b + 15 && b < 140) orange++;
    const mx = Math.max(r, g, b);
    const mn = Math.min(r, g, b);
    if (mx - mn < 20) neutral++;
  }
  return {
    blue_fraction: Number((blue / n).toFixed(4)),
    orange_fraction: Number((orange / n).toFixed(4)),
    neutral_fraction: Number((neutral / n).toFixed(4)),
  };
}

/** Size-agnostic changed-pixel metric used by per-screenshot visual QA. */
export async function changeMetric(imagePath, baselinePath) {
  const width = 256;
  const meta = await sharp(imagePath).metadata();
  const srcW = meta.width ?? width;
  const srcH = meta.height ?? width;
  const height = Math.max(1, Math.round((width * srcH) / srcW));
  const toGrid = (src) =>
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
    changed_fraction: Number((changed / px).toFixed(4)),
    changed_bbox_norm: changed ? [minX, minY, maxX, maxY] : null,
    grid: [width, height],
  };
}

/** Reduce raw diff counters into the MVP verifier's summary shape. */
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
    meanAbsDelta: Number((m.sumAbsDelta / (m.totalPixels * 3)).toFixed(3)),
    resized: Boolean(m.resized),
  };
}

/** Compare two decoded RGBA buffers and optionally build a magenta highlight. */
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

/** Decode current + baseline PNGs, diff them, and optionally write a diff PNG. */
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
  if (resized)
    currentPipeline = currentPipeline.resize(width, height, { fit: "fill" });
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

/** Declarative per-state expectation evaluator for MVP visual verification. */
export function evaluateExpectations(state, spec) {
  const checks = [];
  const vpOverride = spec.ocr?.perViewport?.[state.viewport ?? ""] ?? {};
  const present = [...(spec.ocr?.present ?? []), ...(vpOverride.present ?? [])];
  const absent = [...(spec.ocr?.absent ?? []), ...(vpOverride.absent ?? [])];
  if (present.length || absent.length) {
    if (!state.ocr || state.ocr.available === false) {
      checks.push({
        name: "ocr-text",
        status: "fail",
        detail: `OCR unavailable: ${state.ocr?.reason ?? "engine not configured"}`,
      });
    } else {
      const haystack = normalize(state.ocr.text ?? "");
      const missing = present.filter((s) => !haystack.includes(normalize(s)));
      const forbidden = absent.filter((s) => containsForbidden(haystack, s));
      if (missing.length === 0 && forbidden.length === 0) {
        checks.push({
          name: "ocr-text",
          status: "pass",
          detail: "expected text matched",
        });
      } else {
        const parts = [];
        if (missing.length) parts.push(`missing: ${missing.join(", ")}`);
        if (forbidden.length)
          parts.push(`forbidden present: ${forbidden.join(", ")}`);
        checks.push({
          name: "ocr-text",
          status: "fail",
          detail: parts.join("; "),
        });
      }
    }
  }

  if (spec.noBlue) {
    const domBlue = state.finding?.blueColors ?? null;
    const paletteBlue = state.palette?.buckets?.blue ?? 0;
    const limit = spec.blueCoverageLimit ?? DEFAULT_BLUE_COVERAGE_LIMIT;
    if (domBlue && domBlue.length > 0) {
      checks.push({
        name: "no-blue",
        status: "fail",
        detail: `DOM blue colors: ${domBlue.slice(0, 4).join(", ")}`,
      });
    } else if (paletteBlue > limit) {
      checks.push({
        name: "no-blue",
        status: "fail",
        detail: `palette blue coverage ${(paletteBlue * 100).toFixed(1)}% > ${(limit * 100).toFixed(1)}%`,
      });
    } else {
      checks.push({
        name: "no-blue",
        status: "pass",
        detail: domBlue
          ? "no DOM blue, palette clean"
          : "palette blue within limit",
      });
    }
  }

  if (spec.accentOrange) {
    const orange = state.palette?.buckets?.orange ?? 0;
    const min = spec.orangeCoverageMin ?? DEFAULT_ORANGE_COVERAGE_MIN;
    const swatchOrange = (state.palette?.swatches ?? []).some(
      (s) => s.bucket === "orange",
    );
    if (orange >= min || swatchOrange) {
      checks.push({
        name: "accent-orange",
        status: "pass",
        detail: `orange coverage ${(orange * 100).toFixed(2)}%`,
      });
    } else {
      checks.push({
        name: "accent-orange",
        status: "fail",
        detail: `brand orange not detected (coverage ${(orange * 100).toFixed(2)}%)`,
      });
    }
  }

  if (spec.noHorizontalOverflow) {
    const px = state.finding?.horizontalOverflowPx;
    const tol = spec.overflowTolerancePx ?? DEFAULT_OVERFLOW_TOLERANCE_PX;
    if (px === undefined || px === null) {
      checks.push({
        name: "no-horizontal-overflow",
        status: "skip",
        detail:
          "report has no horizontalOverflowPx field (re-run audit to populate)",
      });
    } else if (px > tol) {
      checks.push({
        name: "no-horizontal-overflow",
        status: "fail",
        detail: `horizontal overflow ${px}px (scrollWidth exceeds innerWidth; tolerance ${tol}px)`,
      });
    } else {
      checks.push({
        name: "no-horizontal-overflow",
        status: "pass",
        detail: `overflow ${px}px within ${tol}px`,
      });
    }
  }

  const reasons = checks
    .filter((c) => c.status === "fail")
    .map((c) => `${c.name}: ${c.detail}`);
  return { pass: reasons.length === 0, checks, reasons };
}

/** Resolve per-slug expectations over `__default__` invariants. */
export function resolveSpec(specs, slug) {
  const base = specs.__default__ ?? {};
  const own = specs[slug] ?? {};
  return {
    ...base,
    ...own,
    ocr: mergeOcr(base.ocr, own.ocr),
  };
}

/** Resolve the system `tesseract` binary path once per process. */
export function resolveTesseract() {
  if (systemTesseractProbe) return systemTesseractProbe.path;
  const envPath = process.env.ELIZA_TESSERACT_BIN;
  if (envPath) {
    systemTesseractProbe = { path: envPath };
    return envPath;
  }
  const which = spawnSync(process.platform === "win32" ? "where" : "which", [
    "tesseract",
  ]);
  const out =
    which.status === 0 ? which.stdout.toString().trim().split(/\r?\n/)[0] : "";
  systemTesseractProbe = { path: out || null };
  return systemTesseractProbe.path;
}

/** Resolve the OCR engine the verifier will use. */
export async function resolveOcrEngine() {
  const forced = process.env.ELIZA_MVP_OCR_ENGINE;
  if (forced !== "system") {
    const packaged = await loadPackagedTesseract();
    if (packaged?.createWorker) {
      return {
        available: true,
        kind: "packaged",
        label: "tesseract.js package",
      };
    }
    if (forced === "packaged") {
      return {
        available: false,
        reason:
          "tesseract.js package is unavailable; run `bun install` so packages/app installs its OCR dependency",
      };
    }
  }

  const bin = resolveTesseract();
  if (bin) {
    return {
      available: true,
      kind: "system",
      label: `system tesseract (${bin})`,
      bin,
    };
  }
  return {
    available: false,
    reason:
      "no OCR engine available; run `bun install` for packaged tesseract.js or set ELIZA_TESSERACT_BIN",
  };
}

/** Test seam: reset the memoized OCR probes. */
export function resetTesseractProbe() {
  systemTesseractProbe = null;
  packagedTesseractProbe = null;
  packagedWorkers = new Map();
}

/**
 * OCR a single PNG, or report an explicit unavailable result.
 *
 * Whole-page segmentation is the cheap first pass. When that pass is weak, a
 * bounded high-contrast upscale plus sparse-text segmentation gets one second
 * chance; this is particularly important for mobile screenshots whose labels
 * are only a dozen source pixels tall. The selected transcript, confidence,
 * every attempted transcript, and independent pixel-blank diagnostics remain
 * in the result so downstream gates never infer "blank" from OCR silence.
 */
export async function ocrImage(pngPath, opts = {}) {
  const engine = await resolveOcrEngine();
  if (!engine.available) return { available: false, reason: engine.reason };
  const lang = opts.lang ?? "eng";
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const confidenceFloor = opts.confidenceFloor ?? DEFAULT_OCR_CONFIDENCE_FLOOR;
  const [primaryOutcome, imageOutcome] = await Promise.allSettled([
    recognizeWithEngine(engine, pngPath, lang, timeoutMs, "auto"),
    analyzeImageFile(pngPath),
  ]);
  if (primaryOutcome.status === "rejected") {
    return {
      available: false,
      reason: `${engine.label} failed: ${errorMessage(primaryOutcome.reason).slice(0, 200)}`,
    };
  }
  if (imageOutcome.status === "rejected") {
    return {
      available: false,
      reason: `pixel diagnostics failed: ${errorMessage(imageOutcome.reason).slice(0, 200)}`,
    };
  }
  const primaryRecognition = primaryOutcome.value;
  const imageAnalysis = imageOutcome.value;

  const attempts = [buildOcrAttempt("auto", primaryRecognition)];
  if (!isReliableOcrAttempt(attempts[0], confidenceFloor)) {
    const fallbackRecognition = await buildHighContrastOcrInput(pngPath)
      .then((fallbackInput) =>
        recognizeWithEngine(
          engine,
          fallbackInput,
          lang,
          timeoutMs,
          "sparse-high-contrast",
        ),
      )
      .catch((err) => {
        // error-policy:J1 OCR primitive boundary — a failed fallback is retained
        // as a diagnostic while the successful primary pass remains inspectable.
        return { error: err instanceof Error ? err.message : String(err) };
      });
    if ("error" in fallbackRecognition) {
      attempts.push({
        mode: "sparse-high-contrast",
        ok: false,
        reason: fallbackRecognition.error,
        text: "",
        words: 0,
        chars: 0,
        meanConfidence: 0,
      });
    } else {
      attempts.push(
        buildOcrAttempt("sparse-high-contrast", fallbackRecognition),
      );
    }
  }

  const selected = selectOcrAttempt(attempts, confidenceFloor);
  return {
    available: true,
    text: selected.text,
    words: selected.words,
    chars: selected.chars,
    meanConfidence: selected.meanConfidence,
    engine: engine.label,
    selectedMode: selected.mode,
    attempts,
    pixelBlank: imageAnalysis.pixelBlank,
    pixelBlankReasons: imageAnalysis.pixelBlankReasons,
    imageAnalysis,
  };
}

/** Legacy visual-qa OCR shape: `{ text, note }`. */
export async function ocrText(pngPath) {
  const result = await ocrImage(pngPath, { timeoutMs: 60_000 });
  if (result.available) return { text: result.text, note: null };
  return { text: "", note: result.reason };
}

/** Terminate packaged OCR workers after a verifier run. */
export async function closeOcrEngines() {
  const workers = [...packagedWorkers.values()];
  packagedWorkers = new Map();
  for (const workerPromise of workers) {
    const worker = await workerPromise;
    await worker.terminate();
  }
}

/**
 * Screenshot heuristics for the evidence-review dashboard's local artifact scan.
 */
export async function analyzeImageFile(filePath) {
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .resize({
      width: 120,
      height: 120,
      fit: "inside",
      withoutEnlargement: true,
    })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const bins = new Map();
  let bluePixels = 0;
  let orangePixels = 0;
  let redPixels = 0;
  let luminanceTotal = 0;

  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] / 255;
    if (alpha < 0.05) continue;

    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const key = [
      quantizeChannel(r, 16),
      quantizeChannel(g, 16),
      quantizeChannel(b, 16),
    ].join(",");
    bins.set(key, (bins.get(key) ?? 0) + 1);

    const { hue, saturation, lightness } = rgbToHsl(r, g, b);
    if (saturation > 0.28 && lightness > 0.18 && lightness < 0.86) {
      if (hue >= 190 && hue <= 255) bluePixels += 1;
      if (hue >= 15 && hue <= 45) orangePixels += 1;
      if (hue <= 8 || hue >= 350) redPixels += 1;
    }
    luminanceTotal += 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  const sampledPixels = Math.max(0, info.width * info.height);
  const topBuckets = [...bins.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([key, count]) => {
      const [r, g, b] = key.split(",").map((n) => Number.parseInt(n, 10));
      return {
        hex: rgbToHex(r, g, b),
        count,
        ratio: sampledPixels === 0 ? 0 : count / sampledPixels,
      };
    });
  const dominantRatio = topBuckets[0]?.ratio ?? 1;
  const averageLuminance =
    sampledPixels === 0 ? 0 : Math.round(luminanceTotal / sampledPixels);
  const issues = [];
  if (sampledPixels === 0) issues.push("screenshot has no sampled pixels");
  if (bins.size <= 1) issues.push("screenshot is one color");
  if (bins.size <= 2 && dominantRatio > 0.995) {
    issues.push("screenshot is effectively one color");
  }
  if (
    dominantRatio > 0.992 &&
    (averageLuminance < 8 || averageLuminance > 247)
  ) {
    issues.push("screenshot is near-solid black/white");
  }
  const blueRatio = sampledPixels === 0 ? 0 : bluePixels / sampledPixels;
  if (
    blueRatio > 0.015 &&
    blueRatio > orangePixels / Math.max(1, sampledPixels)
  ) {
    issues.push("blue accent candidate exceeds orange pixels");
  }
  const pixelBlankReasons = issues.filter((issue) =>
    PROVEN_BLANK_IMAGE_ISSUES.has(issue),
  );

  return {
    width: info.width,
    height: info.height,
    sampledPixels,
    colorBuckets: bins.size,
    dominantRatio,
    dominantColors: topBuckets,
    blueRatio,
    orangeRatio: sampledPixels === 0 ? 0 : orangePixels / sampledPixels,
    redRatio: sampledPixels === 0 ? 0 : redPixels / sampledPixels,
    averageLuminance,
    issues,
    pixelBlank: pixelBlankReasons.length > 0,
    pixelBlankReasons,
  };
}

function mergeOcr(base, own) {
  if (!base && !own) return undefined;
  return {
    present: [...(base?.present ?? []), ...(own?.present ?? [])],
    absent: [...(base?.absent ?? []), ...(own?.absent ?? [])],
    perViewport: { ...(base?.perViewport ?? {}), ...(own?.perViewport ?? {}) },
  };
}

function normalize(s) {
  return String(s).toLowerCase().replace(/\s+/g, " ").trim();
}

function containsForbidden(haystack, token) {
  const needle = normalize(token);
  if (!needle) return false;
  if (/^[a-z0-9_ -]+$/i.test(needle)) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^a-z0-9_])${escaped}($|[^a-z0-9_])`, "i").test(
      haystack,
    );
  }
  return haystack.includes(needle);
}

async function recognizeWithEngine(engine, input, lang, timeoutMs, mode) {
  return engine.kind === "packaged"
    ? runPackagedTesseract(input, lang, timeoutMs, mode)
    : runSystemTesseract(engine.bin, input, lang, timeoutMs, mode);
}

function runSystemTesseract(bin, input, lang, timeoutMs, mode) {
  return new Promise((resolve, reject) => {
    const readsStdin = Buffer.isBuffer(input);
    const inputArg = readsStdin ? "stdin" : input;
    const pageSegMode = mode === "sparse-high-contrast" ? "11" : "3";
    const child = spawn(
      bin,
      [inputArg, "stdout", "-l", lang, "--psm", pageSegMode, "tsv"],
      {
        stdio: [readsStdin ? "pipe" : "ignore", "pipe", "pipe"],
      },
    );
    if (readsStdin) {
      child.stdin.end(input);
    }
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(
          `tesseract timed out after ${timeoutMs}ms on ${readsStdin ? mode : input}`,
        ),
      );
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(parseSystemTesseractTsv(stdout));
      else reject(new Error(`tesseract exited ${code}: ${stderr.trim()}`));
    });
  });
}

function parseSystemTesseractTsv(tsv) {
  const rows = String(tsv).split(/\r?\n/);
  if (!rows[0]?.startsWith("level\tpage_num\t")) {
    throw new Error("system tesseract returned an invalid TSV header");
  }
  const lines = new Map();
  let confidenceTotal = 0;
  let confidenceCount = 0;
  for (const row of rows.slice(1)) {
    if (!row) continue;
    const columns = row.split("\t");
    if (columns.length < 12 || columns[0] !== "5") continue;
    const text = columns.slice(11).join("\t").trim();
    if (!text) continue;
    const confidence = Number(columns[10]);
    if (!Number.isFinite(confidence)) {
      throw new Error("system tesseract returned a non-numeric confidence");
    }
    const key = columns.slice(1, 5).join(":");
    const current = lines.get(key);
    if (current) current.push(text);
    else lines.set(key, [text]);
    if (confidence >= 0) {
      confidenceTotal += confidence;
      confidenceCount += 1;
    }
  }
  return {
    text: [...lines.values()].map((words) => words.join(" ")).join("\n"),
    meanConfidence:
      confidenceCount === 0
        ? 0
        : Math.min(1, Math.max(0, confidenceTotal / confidenceCount / 100)),
  };
}

async function loadPackagedTesseract() {
  if (!packagedTesseractProbe) {
    packagedTesseractProbe = import(TESSERACT_JS_PACKAGE).catch(() => null);
  }
  return packagedTesseractProbe;
}

async function runPackagedTesseract(input, lang, timeoutMs, mode) {
  const worker = await getPackagedWorker(lang, timeoutMs, mode);
  const result = await withTimeout(
    worker.recognize(input),
    timeoutMs,
    `tesseract.js timed out after ${timeoutMs}ms during ${mode}`,
  );
  if (
    !result?.data ||
    typeof result.data.text !== "string" ||
    typeof result.data.confidence !== "number" ||
    !Number.isFinite(result.data.confidence)
  ) {
    throw new Error("tesseract.js returned no transcript confidence");
  }
  return {
    text: result.data.text,
    meanConfidence: Math.min(1, Math.max(0, result.data.confidence / 100)),
  };
}

async function getPackagedWorker(lang, timeoutMs, mode) {
  const workerKey = `${lang}:${mode}`;
  const existing = packagedWorkers.get(workerKey);
  if (existing) return existing;
  const workerPromise = (async () => {
    const tesseract = await loadPackagedTesseract();
    if (!tesseract?.createWorker) {
      throw new Error("tesseract.js createWorker export is unavailable");
    }
    mkdirSync(TESSERACT_JS_CACHE_DIR, { recursive: true });
    const worker = await withTimeout(
      tesseract.createWorker(lang, 1, { cachePath: TESSERACT_JS_CACHE_DIR }),
      timeoutMs,
      `tesseract.js worker initialization timed out after ${timeoutMs}ms`,
    );
    if (mode === "sparse-high-contrast") {
      if (!tesseract.PSM?.SPARSE_TEXT) {
        await worker.terminate();
        throw new Error("tesseract.js sparse-text segmentation is unavailable");
      }
      await withTimeout(
        worker.setParameters({
          tessedit_pageseg_mode: tesseract.PSM.SPARSE_TEXT,
        }),
        timeoutMs,
        `tesseract.js sparse-text configuration timed out after ${timeoutMs}ms`,
      );
    }
    return worker;
  })();
  const trackedWorkerPromise = workerPromise.then(
    (worker) => worker,
    (error) => {
      packagedWorkers.delete(workerKey);
      throw error;
    },
  );
  packagedWorkers.set(workerKey, trackedWorkerPromise);
  return trackedWorkerPromise;
}

async function buildHighContrastOcrInput(pngPath) {
  const metadata = await sharp(pngPath).metadata();
  if (!metadata.width || metadata.width <= 0) {
    throw new Error("OCR image has no positive pixel width");
  }
  const width = Math.min(
    OCR_FALLBACK_MAX_WIDTH,
    metadata.width * OCR_FALLBACK_SCALE,
  );
  return sharp(pngPath)
    .resize({ width, kernel: sharp.kernel.lanczos3 })
    .grayscale()
    .normalize()
    .sharpen()
    .threshold(OCR_FALLBACK_THRESHOLD)
    .png()
    .toBuffer();
}

function buildOcrAttempt(mode, recognition) {
  const text = normalizeOcrText(recognition.text);
  return {
    mode,
    ok: true,
    text,
    words: text ? text.split(/\s+/).filter(Boolean).length : 0,
    chars: text.replace(/\s+/g, "").length,
    meanConfidence: recognition.meanConfidence,
  };
}

function isReliableOcrAttempt(attempt, confidenceFloor) {
  return (
    attempt.ok &&
    attempt.words >= 2 &&
    attempt.meanConfidence >= confidenceFloor
  );
}

function selectOcrAttempt(attempts, confidenceFloor) {
  const successful = attempts.filter((attempt) => attempt.ok);
  if (successful.length === 0) {
    throw new Error("OCR produced no successful attempt");
  }
  return successful.reduce((best, candidate) => {
    const bestReliable = isReliableOcrAttempt(best, confidenceFloor);
    const candidateReliable = isReliableOcrAttempt(candidate, confidenceFloor);
    if (candidateReliable !== bestReliable) {
      return candidateReliable ? candidate : best;
    }
    const bestScore =
      best.meanConfidence * Math.log2(Math.max(2, best.words + 1));
    const candidateScore =
      candidate.meanConfidence * Math.log2(Math.max(2, candidate.words + 1));
    if (candidateScore !== bestScore) {
      return candidateScore > bestScore ? candidate : best;
    }
    if (candidate.words !== best.words) {
      return candidate.words > best.words ? candidate : best;
    }
    return candidate.chars > best.chars ? candidate : best;
  });
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

function normalizeOcrText(text) {
  if (typeof text !== "string") {
    throw new Error("OCR transcript must be a string");
  }
  return text
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .trim();
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function fileExists(p) {
  return access(p).then(
    () => true,
    () => false,
  );
}

function quantizeChannel(value, step) {
  return Math.max(0, Math.min(255, Math.round(value / step) * step));
}

function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const lightness = (max + min) / 2;
  if (max === min) return { hue: 0, saturation: 0, lightness };
  const delta = max - min;
  const saturation =
    lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue;
  if (max === rn) hue = (gn - bn) / delta + (gn < bn ? 6 : 0);
  else if (max === gn) hue = (bn - rn) / delta + 2;
  else hue = (rn - gn) / delta + 4;
  return { hue: hue * 60, saturation, lightness };
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b]
    .map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0"))
    .join("")}`;
}
