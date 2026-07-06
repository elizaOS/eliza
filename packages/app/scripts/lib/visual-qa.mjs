/**
 * Per-screenshot visual-QA analysis for the device/app evidence pipeline.
 *
 * Turns one captured screenshot (+ an optional baseline and an expectation
 * spec) into a structured, hand-reviewable assessment that sits next to the
 * pixels in a triage bundle (#14336): OCR'd on-screen text, the dominant colour
 * palette, brand-rule colour fractions (elizaOS: orange is accent-only, no blue
 * — packages/app/AGENTS.md), a size-agnostic pixel change-metric vs a baseline,
 * and expectation validation (required text present, forbidden text absent,
 * blue under a ceiling). The point is that a reviewer reads the SAME numbers a
 * gate asserts on, right beside the screenshot — so "looks fine" becomes
 * "OCR shows the expected copy, palette is neutral, 0.0 blue, verdict pass".
 *
 * Pixels come from `sharp` (already a repo dep); OCR shells to the `tesseract`
 * CLI when present and degrades to an explicit note (never a fabricated empty
 * read) when it is not, so the analyzer is safe to call from any capture lane.
 */
import { execFile } from "node:child_process";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const execFileAsync = promisify(execFile);

/** Top-k colours by area, from a downscaled quantized thumbnail. */
async function dominantPalette(image, k = 6) {
  // Reduce to a small palette PNG; sharp's palette output gives us the actual
  // colours it chose plus their pixel counts via the raw indexed buffer.
  const thumb = sharp(image).resize(160, 160, { fit: "fill" });
  const { data, info } = await thumb
    .raw()
    .toBuffer({ resolveWithObject: true });
  const buckets = new Map();
  const step = info.channels;
  for (let i = 0; i < data.length; i += step) {
    // 4-bit-per-channel quantization keeps neighbouring shades in one bucket.
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
        hex: `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`,
        rgb: [r, g, b],
        fraction: Number((count / total).toFixed(4)),
      };
    });
}

/**
 * Fraction of pixels reading as blue / orange / near-neutral. Blue = b clearly
 * dominates r,g; orange = warm r>g>b with a high red. Brand rule keys on these.
 */
async function colorFractions(image) {
  const { data, info } = await sharp(image)
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

function normalizeOcrText(stdout) {
  const lines = stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.join("\n");
}

async function runTesseract(pngPath, { psm = "6", cwd } = {}) {
  const { stdout } = await execFileAsync(
    "tesseract",
    [pngPath, "stdout", "--psm", psm],
    { timeout: 60_000, maxBuffer: 8 * 1024 * 1024, cwd },
  );
  return normalizeOcrText(stdout);
}

/**
 * Some macOS tesseract/leptonica builds fail to open screenshots from `/tmp`
 * even when normal file APIs can read the PNG. Retrying from the caller's
 * workspace keeps OCR useful for evidence bundles that live under `/tmp`.
 */
async function retryOcrFromWorkspaceCopy(pngPath) {
  const cwd = process.cwd();
  const workspaceRoot = cwd && !cwd.startsWith(tmpdir()) ? cwd : null;
  if (!workspaceRoot) return null;
  const tempDir = await mkdtemp(path.join(workspaceRoot, ".visual-qa-ocr-"));
  try {
    const copied = path.join(tempDir, "screenshot.png");
    await copyFile(pngPath, copied);
    return await runTesseract(path.relative(workspaceRoot, copied), {
      psm: "11",
      cwd: workspaceRoot,
    });
  } finally {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch {
      // error-policy:J6 temporary OCR cleanup is best-effort; a failed delete
      // should not turn a valid screenshot analysis into a false failure.
    }
  }
}

/** On-screen text via the tesseract CLI, or an explicit note when unavailable. */
async function ocrText(pngPath) {
  try {
    return { text: await runTesseract(pngPath), note: null };
  } catch (err) {
    try {
      const retryText = await retryOcrFromWorkspaceCopy(pngPath);
      if (retryText !== null) {
        return {
          text: retryText,
          note: "primary tesseract read failed; OCR succeeded from a workspace-local copy",
        };
      }
    } catch {
      // error-policy:J3 the explicit note below reports the primary OCR failure;
      // retry failure does not fabricate text or hide the unavailable signal.
    }
    // error-policy:J3 OCR is optional enrichment; report absence explicitly
    // rather than fabricate an empty transcript as "no text on screen".
    const note =
      err?.code === "ENOENT"
        ? "tesseract not installed"
        : `tesseract failed: ${String(err?.message ?? err).slice(0, 120)}`;
    return { text: "", note };
  }
}

/**
 * Size-agnostic pixel change vs a baseline: both are resized to a common 256px
 * grid and compared per-pixel on the max channel delta (threshold rejects
 * compression noise). Returns the changed fraction and the changed bounding box.
 */
async function changeMetric(image, baselinePath) {
  const width = 256;
  const meta = await sharp(image).metadata();
  const height = Math.max(1, Math.round((width * meta.height) / meta.width));
  const toGrid = (src) =>
    sharp(src)
      .resize(width, height, { fit: "fill" })
      .removeAlpha()
      .raw()
      .toBuffer();
  const [a, b] = await Promise.all([toGrid(image), toGrid(baselinePath)]);
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

/**
 * Pure expectation evaluator — the gate logic, split out so it is testable
 * without a screenshot or tesseract. Given the OCR `text` and `colors` for a
 * state, apply the `expect` spec and return `{ checks, verdict }`. A missing
 * required string or a present forbidden string fails; blue over the ceiling
 * fails the brand rule (default ceiling 0.02, overridable per state).
 */
export function evaluateExpectation({ text = "", colors, expect = {} }) {
  const lowered = text.toLowerCase();
  const checks = [];
  let verdict = "pass";
  const check = (name, ok, detail) => {
    checks.push({ name, ok: Boolean(ok), detail });
    if (!ok) verdict = "fail";
  };
  for (const needle of expect.require_text ?? []) {
    const ok = lowered.includes(needle.toLowerCase());
    check(
      `require_text:${needle}`,
      ok,
      `'${needle}' ${ok ? "found" : "MISSING"} in OCR`,
    );
  }
  for (const needle of expect.forbid_text ?? []) {
    const bad = lowered.includes(needle.toLowerCase());
    check(
      `forbid_text:${needle}`,
      !bad,
      `'${needle}' ${bad ? "present (BAD)" : "absent"}`,
    );
  }
  const maxBlue = expect.max_blue_fraction ?? 0.02;
  check(
    "brand:no_blue",
    colors.blue_fraction <= maxBlue,
    `blue_fraction=${colors.blue_fraction} (max ${maxBlue})`,
  );
  return { checks, verdict };
}

/**
 * Analyze one screenshot into a verdict report. `expect` is an optional spec:
 * `{ state, require_text[], forbid_text[], max_blue_fraction }`.
 */
export async function analyzeScreenshot(
  pngPath,
  { baseline = null, expect = {} } = {},
) {
  const meta = await sharp(pngPath).metadata();
  const [{ text, note }, palette, colors] = await Promise.all([
    ocrText(pngPath),
    dominantPalette(pngPath),
    colorFractions(pngPath),
  ]);
  const { checks, verdict } = evaluateExpectation({ text, colors, expect });
  const report = {
    image: pngPath,
    size: [meta.width, meta.height],
    state: expect.state ?? null,
    ocr_text: text,
    ocr_note: note,
    dominant_palette: palette,
    color_fractions: colors,
    checks,
    verdict,
  };
  if (baseline)
    report.change_vs_baseline = await changeMetric(pngPath, baseline);
  return report;
}

// Expose the primitives for callers that want one signal (e.g. a lane that only
// gates on brand colour) without the full report.
export { changeMetric, colorFractions, dominantPalette, ocrText };
