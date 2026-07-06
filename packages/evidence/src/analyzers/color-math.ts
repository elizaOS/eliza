/**
 * Shared colour classification used by both `brand.rules` (whole-frame
 * fractions) and `color.corners` (per-swatch bucket). The elizaOS brand rule —
 * orange is accent-only, no blue anywhere (packages/app/AGENTS.md) — is encoded
 * once here so the fraction analyzer and the corner analyzer agree on exactly
 * what counts as "blue" vs "orange" vs "neutral". Thresholds are ported
 * verbatim from `packages/app/scripts/lib/visual-qa.mjs` so ported analyzers
 * reproduce the existing gate's numbers.
 */

/** One of the four buckets a pixel or swatch is classified into. */
export type ColorBucket = "blue" | "orange" | "neutral" | "other";

/**
 * Classify a single RGB triple. Blue = b clearly dominates r and g; orange =
 * warm r>g>b with a high red and a capped blue; neutral = low channel spread;
 * everything else is `other`. Order matters: blue and orange are checked before
 * neutral because a saturated colour is never neutral.
 */
export function classifyColor(r: number, g: number, b: number): ColorBucket {
  if (b > r + 30 && b > g + 30 && b > 90) return "blue";
  if (r > 150 && r > g + 25 && g > b + 15 && b < 140) return "orange";
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  if (mx - mn < 20) return "neutral";
  return "other";
}

/** Fractions of a pixel buffer reading as blue / orange / neutral. */
export interface ColorFractions {
  blue_fraction: number;
  orange_fraction: number;
  neutral_fraction: number;
}

/**
 * Blue/orange/neutral fractions over a raw RGB(A) buffer. `channels` is 3 or 4;
 * alpha is ignored. Rounded to 4 decimals to match the ported gate's output.
 */
export function colorFractionsFromRaw(
  data: Uint8Array | Buffer,
  channels: number,
): ColorFractions {
  const n = data.length / channels || 1;
  let blue = 0;
  let orange = 0;
  let neutral = 0;
  for (let i = 0; i < data.length; i += channels) {
    const bucket = classifyColor(data[i], data[i + 1], data[i + 2]);
    if (bucket === "blue") blue++;
    else if (bucket === "orange") orange++;
    else if (bucket === "neutral") neutral++;
  }
  return {
    blue_fraction: round4(blue / n),
    orange_fraction: round4(orange / n),
    neutral_fraction: round4(neutral / n),
  };
}

/** Round to 4 decimal places, the fixed precision used across colour outputs. */
export function round4(value: number): number {
  return Number(value.toFixed(4));
}
