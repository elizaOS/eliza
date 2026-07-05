/**
 * Pixel-truth content rules for the all-views audit: given the text Apple Vision
 * OCR'd out of a captured view screenshot, decide whether the pixels a user
 * actually sees are healthy, and whether they match what the view is supposed to
 * show.
 *
 * This closes the gap the DOM-derived metrics in `aesthetic-audit-rules.ts` can't
 * see. `readableChars` counts text in the DOM tree; it says nothing about what
 * painted. A view can carry a full DOM subtree and still render blank (white on
 * white, a collapsed flex child, a z-index'd overlay), leak a developer string
 * (`[object Object]`, `undefined`, an unresolved `{{token}}`), or simply be
 * missing the label it exists to show. Only the rendered pixels reveal those, and
 * the rules here operate on the OCR of those pixels.
 *
 * Kept dependency-free (no Vision, no `page`, no fs) so it unit-tests as pure
 * functions, mirroring how `aesthetic-audit-rules.ts` was extracted from its
 * Playwright spec. The CLI (`ocr-triage.mjs`) and, in CI, the audit spec, supply
 * the OCR and consume the verdict.
 */

export interface OcrResult {
  /** False when the image failed to decode; treated as an audit failure, never as empty content. */
  ok: boolean;
  text: string;
  lines: string[];
  words: number;
  /** Mean Vision top-candidate confidence, 0..1. Low + non-empty ⇒ noisy/garbled pixels. */
  meanConfidence: number;
}

/**
 * What a given view's pixels must (and must not) contain. `requireAll` labels
 * must every one appear; `requireAny` needs at least one (use for a view that can
 * legitimately show one of several states); `forbid` must never appear. Matching
 * is case-insensitive over whitespace-collapsed text.
 */
export interface OcrExpectation {
  requireAll?: string[];
  requireAny?: string[];
  forbid?: string[];
}

export type OcrVerdict = "verified" | "needs-eyeball" | "broken";

export interface OcrContentFinding {
  verdict: OcrVerdict;
  /** ok && the pixels carry essentially no readable text, on a view that should show some. */
  blankPixels: boolean;
  /** Developer-only strings that must never reach a user (see {@link DEVELOPER_LEAK_PATTERNS}). */
  errorLeaks: string[];
  /** Scaffolding text left in the render (lorem, TODO, unresolved template tokens). */
  placeholderLeaks: string[];
  /** `requireAll`/`requireAny` labels the pixels were supposed to show but didn't. */
  missingRequired: string[];
  /** `forbid` labels the pixels showed but shouldn't have. */
  forbiddenPresent: string[];
  reasons: string[];
}

/**
 * Strings that are always a defect when a user can read them off the screen —
 * the residue of a broken render path, not legitimate UI copy. Deliberately
 * narrow: plain "error"/"failed" is excluded because a designed error state
 * ("Something went wrong — retry") is a correct render, and flagging it would
 * punish the exact three-state discipline the app is supposed to have. These
 * patterns only match the machine residue a user should never see.
 */
export const DEVELOPER_LEAK_PATTERNS: RegExp[] = [
  /\[object (?:Object|Promise|HTMLElement|Array)\]/i,
  /\bundefined\b/,
  /\bNaN\b/,
  /\bnull\b/,
  /\b(?:Type|Reference|Syntax|Range)Error\b/,
  /Cannot read propert(?:y|ies)/i,
  /is not a function/i,
  /is not defined/i,
  /Unhandled (?:Promise )?[Rr]ejection/,
  /Minified React error/i,
  /Objects are not valid as a React child/i,
  /Hydration failed/i,
];

/** Scaffolding that should have been replaced before ship. */
export const PLACEHOLDER_PATTERNS: RegExp[] = [
  /lorem ipsum/i,
  /\bTODO\b/,
  /\bFIXME\b/,
  /placeholder text/i,
  /\{\{[^}]*\}\}/, // unresolved mustache/handlebars token
  /%[sd]\b/, // unresolved printf token
  /\byour text here\b/i,
];

/** Collapse to a case-insensitive, single-spaced haystack for substring checks. */
export function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function detectErrorLeaks(text: string): string[] {
  const out: string[] = [];
  for (const re of DEVELOPER_LEAK_PATTERNS) {
    const m = text.match(re);
    if (m) out.push(m[0]);
  }
  return out;
}

export function detectPlaceholderLeaks(text: string): string[] {
  const out: string[] = [];
  for (const re of PLACEHOLDER_PATTERNS) {
    const m = text.match(re);
    if (m) out.push(m[0]);
  }
  return out;
}

/**
 * Minimum words of OCR'd text below which a non-exempt view is considered to
 * have painted nothing. A single glyph (a lone "+" FAB, a spinner) clears no bar;
 * two real words is the floor for "this view showed the user something".
 */
export const BLANK_PIXEL_WORD_FLOOR = 2;

export interface EvaluateArgs {
  ocr: OcrResult;
  expectation?: OcrExpectation;
  /** TUI terminals and native/canvas overlays legitimately OCR to little/no text. */
  exemptFromBlank?: boolean;
}

export function evaluateOcrContent({
  ocr,
  expectation,
  exemptFromBlank = false,
}: EvaluateArgs): OcrContentFinding {
  const reasons: string[] = [];

  if (!ocr.ok) {
    return {
      verdict: "broken",
      blankPixels: false,
      errorLeaks: [],
      placeholderLeaks: [],
      missingRequired: [],
      forbiddenPresent: [],
      reasons: ["screenshot failed to decode"],
    };
  }

  const hay = normalize(ocr.text);
  const errorLeaks = detectErrorLeaks(ocr.text);
  const placeholderLeaks = detectPlaceholderLeaks(ocr.text);
  const blankPixels = !exemptFromBlank && ocr.words < BLANK_PIXEL_WORD_FLOOR;

  const missingRequired: string[] = [];
  const forbiddenPresent: string[] = [];
  if (expectation) {
    for (const label of expectation.requireAll ?? []) {
      if (!hay.includes(normalize(label))) missingRequired.push(label);
    }
    const anyLabels = expectation.requireAny ?? [];
    if (anyLabels.length > 0 && !anyLabels.some((l) => hay.includes(normalize(l)))) {
      // Report the whole disjunction as one miss so the reason is legible.
      missingRequired.push(anyLabels.join(" | "));
    }
    for (const label of expectation.forbid ?? []) {
      if (hay.includes(normalize(label))) forbiddenPresent.push(label);
    }
  }

  if (blankPixels) reasons.push("pixels are blank — view painted no readable text");
  if (errorLeaks.length) reasons.push(`developer string on screen: ${errorLeaks.join(", ")}`);
  if (missingRequired.length) reasons.push(`missing expected content: ${missingRequired.join(", ")}`);
  if (placeholderLeaks.length) reasons.push(`placeholder/scaffolding on screen: ${placeholderLeaks.join(", ")}`);
  if (forbiddenPresent.length) reasons.push(`forbidden content on screen: ${forbiddenPresent.join(", ")}`);

  // Precedence: a user-visible defect (blank, dev-string, or a required label the
  // view exists to show but didn't) is broken. Softer signals — scaffolding text,
  // a forbidden-but-not-required leak — are needs-eyeball. A view with an
  // expectation that fully matched and no defect is positively verified, which is
  // the whole point: it earns its way out of the manual pile.
  let verdict: OcrVerdict;
  if (blankPixels || errorLeaks.length > 0 || missingRequired.length > 0) {
    verdict = "broken";
  } else if (placeholderLeaks.length > 0 || forbiddenPresent.length > 0) {
    verdict = "needs-eyeball";
  } else if (expectation && (expectation.requireAll?.length || expectation.requireAny?.length)) {
    verdict = "verified";
    reasons.push("pixels match declared expectation");
  } else {
    // No expectation to check against: healthy pixels, but we can't positively
    // vouch for correctness, so it stays a soft signal rather than a green claim.
    verdict = "needs-eyeball";
    reasons.push("no expectation declared — pixels readable but unverified");
  }

  return {
    verdict,
    blankPixels,
    errorLeaks,
    placeholderLeaks,
    missingRequired,
    forbiddenPresent,
    reasons,
  };
}
