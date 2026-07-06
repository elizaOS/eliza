/**
 * Per-screenshot visual-QA analysis for device/app evidence.
 *
 * This adapter preserves the historical report shape consumed by capture lanes,
 * while OCR, dominant-palette, brand-fraction, and pixel-change primitives live
 * in `@elizaos/evidence/visual-primitives`. Reviewers and gates now read the
 * same numbers no matter which screenshot pipeline produced the artifact.
 */

import {
  changeMetric,
  closeOcrEngines,
  brandColorFractionsFromPng as colorFractions,
  dominantPalette,
  ocrText,
} from "@elizaos/evidence/visual-primitives";
import sharp from "sharp";

/**
 * Pure expectation evaluator for the older visual-qa report shape:
 * `{ require_text[], forbid_text[], max_blue_fraction }`.
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
 * Analyze one screenshot into the report shape written beside device captures.
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
  if (baseline) {
    report.change_vs_baseline = await changeMetric(pngPath, baseline);
  }
  return report;
}

export {
  changeMetric,
  closeOcrEngines,
  colorFractions,
  dominantPalette,
  ocrText,
};
