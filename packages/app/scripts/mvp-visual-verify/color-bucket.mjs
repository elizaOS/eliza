/**
 * Coarse brand-color classifier for the mvp-visual-verify post-processor.
 *
 * This is a faithful ESM port of `parseRgb` / `bucket` from
 * `test/ui-smoke/aesthetic-audit-rules.ts` — the audit spec's canonical no-blue /
 * orange-accent policy. The audit rules live in a `.ts` module the Playwright
 * runner imports; this post-processor is a plain-node `.mjs` pipeline that cannot
 * import that TS at runtime, so the hue-based bucketing is reproduced here and
 * pinned to the audit's behavior by the parity block in
 * `test/audit/mvp-visual-verify.test.ts`. Keep the two in lockstep: a divergence
 * would let the visual-verify accent check accept a blue the audit bans.
 *
 * Chromatic classification is HUE-based (orange ~10-50°, blue ~200-270°), not a
 * raw-channel threshold, so the shipped brand accent `rgb(255,88,0)` (g=88) is
 * still classified orange rather than falling through to neutral.
 */

/** @typedef {"orange"|"black"|"blue"|"white"|"neutral"|"transparent"} Bucket */

/**
 * Parse a CSS `rgb()` / `rgba()` string into `[r, g, b, a]` (a defaults to 1).
 * Returns null for any other color form (named, hex, hsl) — callers that need a
 * bucket for those must convert first.
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
 * Bucket an RGB triple into a coarse brand category. Split out from
 * {@link bucket} so the dominant-color quantizer can classify raw pixel channels
 * without stringifying each color first.
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @param {number} [a=1]
 * @returns {Bucket}
 */
export function bucketRgb(r, g, b, a = 1) {
  if (a === 0) return "transparent";
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const chroma = max - min;
  const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const saturation = max === 0 ? 0 : chroma / max;

  if (lum > 0.95 && saturation < 0.05) return "white";
  // Gate on ABSOLUTE chroma too: at low luminance a 1-2/255 spread yields a high
  // chroma/max ratio yet is perceptually black, so a dark scrim must not escape
  // here and get hue-classified as a saturated "blue".
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
 * Bucket a CSS color string. Non-rgb() inputs classify as "neutral" (matching the
 * audit rules — the DOM scans only ever feed computed `rgb()`/`rgba()` values).
 * @param {string} color
 * @returns {Bucket}
 */
export function bucket(color) {
  const rgb = parseRgb(color);
  if (!rgb) return "neutral";
  return bucketRgb(rgb[0], rgb[1], rgb[2], rgb[3]);
}
