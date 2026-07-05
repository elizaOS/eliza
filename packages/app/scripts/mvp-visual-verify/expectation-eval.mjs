/**
 * Declarative per-state expectation evaluator for mvp-visual-verify.
 *
 * A pure function: given a captured state's OCR text, dominant-color palette, and
 * the matching audit `report.json` finding, plus a declarative spec (expected OCR
 * substrings present/absent, brand-orange accent present, no blue, no horizontal
 * overflow), it returns a pass/fail verdict with per-check reasons. No I/O — the
 * post-processor gathers the inputs and this decides, so the acceptance logic is
 * unit-tested against fixtures.
 *
 * Design choices that keep it honest: a required OCR readout fails when the
 * engine is unavailable because text verification is part of the MVP acceptance
 * signal. Report-derived layout fields may still resolve to `skip` when an old
 * audit report lacks the field; strict mode rejects those skips. The no-blue
 * signal prefers the audit's DOM-computed `blueColors[]` (authoritative) and
 * treats palette-derived blue as a secondary floor, because photographic or
 * gradient content can carry stray blue pixels the brand rule does not target.
 */

/** Coverage fraction of the palette's blue bucket above which blue is flagged. */
export const DEFAULT_BLUE_COVERAGE_LIMIT = 0.05;
/** Palette orange coverage at/above which the brand accent counts as present. */
export const DEFAULT_ORANGE_COVERAGE_MIN = 0.0005;
/** scrollWidth − innerWidth (px) tolerated before horizontal overflow fails. */
export const DEFAULT_OVERFLOW_TOLERANCE_PX = 2;

/**
 * @typedef {object} OcrSpec
 * @property {string[]} [present] substrings that must appear (whitespace-normalized)
 * @property {string[]} [absent]  junk tokens that must NOT appear (whole-word)
 * @property {Record<string, { present?: string[], absent?: string[] }>} [perViewport]
 *   per-viewport overrides — text chrome differs between desktop and mobile
 *   layouts, so `present` labels are usually viewport-specific.
 */

/**
 * @typedef {object} ExpectationSpec
 * @property {OcrSpec} [ocr]
 * @property {boolean} [accentOrange]  require brand-orange coverage in the palette
 * @property {boolean} [noBlue]        forbid blue (DOM + palette)
 * @property {boolean} [noHorizontalOverflow] forbid scrollWidth > innerWidth
 * @property {number}  [blueCoverageLimit]
 * @property {number}  [orangeCoverageMin]
 * @property {number}  [overflowTolerancePx]
 */

/**
 * @typedef {object} StateInput
 * @property {string} [viewport] viewport name — selects per-viewport OCR overrides
 * @property {{ available: boolean, text?: string }} ocr
 * @property {{ buckets?: Record<string, number>, swatches?: Array<{ bucket: string }> }} palette
 * @property {{ blueColors?: string[], consoleErrors?: string[], horizontalOverflowPx?: number } | null} finding
 */

/**
 * Evaluate one captured state against its spec.
 * @param {StateInput} state
 * @param {ExpectationSpec} spec
 * @returns {{ pass: boolean, checks: Array<{ name: string, status: "pass"|"fail"|"skip", detail: string }>, reasons: string[] }}
 */
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
      // Whole-word match for junk tokens: a substring "nan" inside "finances"
      // is not a NaN render bug, so alphanumeric tokens are boundary-matched.
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

/**
 * Resolve the spec for a slug: the per-slug entry shallow-merged onto the
 * `__default__` entry (per-slug wins). The default carries the universal
 * invariants so every state is checked even without an explicit entry.
 * @param {Record<string, ExpectationSpec>} specs
 * @param {string} slug
 * @returns {ExpectationSpec}
 */
export function resolveSpec(specs, slug) {
  const base = specs.__default__ ?? {};
  const own = specs[slug] ?? {};
  return {
    ...base,
    ...own,
    ocr: mergeOcr(base.ocr, own.ocr),
  };
}

function mergeOcr(base, own) {
  if (!base && !own) return undefined;
  return {
    present: [...(base?.present ?? []), ...(own?.present ?? [])],
    absent: [...(base?.absent ?? []), ...(own?.absent ?? [])],
    // Own perViewport wins per key; the default rarely sets it.
    perViewport: { ...(base?.perViewport ?? {}), ...(own?.perViewport ?? {}) },
  };
}

function normalize(s) {
  return String(s).toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Whether a forbidden junk token appears in the OCR haystack. Alphanumeric-only
 * tokens (nan, undefined) are matched at word boundaries so they don't fire
 * inside legitimate words (e.g. "nan" in "finances"); tokens carrying
 * punctuation ("[object Object]") never occur in real words, so a plain
 * substring test is both sufficient and correct for them.
 */
function containsForbidden(haystack, token) {
  const needle = normalize(token);
  if (!needle) return false;
  if (/^[a-z0-9]+$/.test(needle)) {
    return new RegExp(`(^|[^a-z0-9])${needle}([^a-z0-9]|$)`, "i").test(
      haystack,
    );
  }
  return haystack.includes(needle);
}
