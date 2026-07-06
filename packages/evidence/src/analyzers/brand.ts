/**
 * `brand.rules` — whole-frame blue/orange/neutral fractions plus a brand-rule
 * verdict. The elizaOS brand rule (packages/app/AGENTS.md) is orange-accent-only
 * and no-blue-anywhere: blue over a small ceiling fails, and orange over a large
 * ceiling is flagged as over-accented (accent, not fill). Fractions are ported
 * from `packages/app/scripts/lib/visual-qa.mjs` via the shared colour math so
 * this analyzer and `color.corners` classify pixels identically.
 */

import sharp from "sharp";
import { type ColorFractions, colorFractionsFromRaw } from "./color-math.ts";
import type { Analyzer, AnalyzerFragment, AnalyzerInput } from "./types.ts";

/** Ceilings above which a fraction violates the brand rule. */
export const BRAND_THRESHOLDS = {
  /** Blue is disallowed; a small ceiling tolerates antialiasing noise. */
  maxBlueFraction: 0.02,
  /** Orange is an accent; more than this reads as fill, not accent. */
  maxOrangeFraction: 0.35,
} as const;

/** One brand-rule check result. */
export interface BrandCheck {
  name: string;
  ok: boolean;
  detail: string;
}

/** Payload of a `ran` `brand.rules` result. */
export interface BrandData extends ColorFractions {
  checks: BrandCheck[];
  verdict: "pass" | "fail";
}

/** Compute the whole-frame colour fractions over a downscaled raw buffer. */
export async function brandColorFractions(
  imagePath: string,
): Promise<ColorFractions> {
  const { data, info } = await sharp(imagePath)
    .resize(200, 200, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  return colorFractionsFromRaw(data, info.channels);
}

/** Apply the brand thresholds to precomputed fractions (pure, testable). */
export function evaluateBrand(fractions: ColorFractions): BrandData {
  const checks: BrandCheck[] = [];
  let verdict: "pass" | "fail" = "pass";
  const check = (name: string, ok: boolean, detail: string) => {
    checks.push({ name, ok, detail });
    if (!ok) verdict = "fail";
  };
  check(
    "no_blue",
    fractions.blue_fraction <= BRAND_THRESHOLDS.maxBlueFraction,
    `blue_fraction=${fractions.blue_fraction} (max ${BRAND_THRESHOLDS.maxBlueFraction})`,
  );
  check(
    "orange_is_accent",
    fractions.orange_fraction <= BRAND_THRESHOLDS.maxOrangeFraction,
    `orange_fraction=${fractions.orange_fraction} (max ${BRAND_THRESHOLDS.maxOrangeFraction})`,
  );
  return { ...fractions, checks, verdict };
}

export const brandRulesAnalyzer: Analyzer = {
  name: "brand.rules",
  tier: "cpu",
  kinds: ["screenshot", "keyframe"],
  async analyze(input: AnalyzerInput): Promise<AnalyzerFragment> {
    const fractions = await brandColorFractions(input.absolutePath);
    return { status: "ran", data: evaluateBrand(fractions) };
  },
};
