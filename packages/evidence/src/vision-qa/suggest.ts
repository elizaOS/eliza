/**
 * Deterministic question generator: turn heuristic analysis anomalies into
 * targeted VLM questions. This is the mechanical bridge that lets a reviewing
 * agent go from `analysis.json` (blue-fraction, diff regions, OCR strings — the
 * cheap semantic layer) to the exact questions a vision model can answer that
 * the heuristics cannot ("what UI element changed in this region?", "is that
 * blue element a brand violation?", "is placeholder text visible?"). Pure and
 * deterministic — same analysis in, same questions out — so its output is unit-
 * testable and the certify reviewer can regenerate it without a model call.
 *
 * Input is intentionally permissive: it accepts the aesthetic-audit analysis
 * shape (`color_fractions.blue_fraction`, `change_vs_baseline.changed_fraction`
 * + `changed_bbox_norm`, `ocr_text`) as well as camelCase equivalents, because
 * both naming styles exist across the harness. Unknown fields are ignored, not
 * rejected — a new analyzer signal simply produces no questions until a rule is
 * added here.
 */

import type { VisionQuestion } from "./types.ts";

/** Analysis fields this generator reads. All optional; unknown keys ignored. */
export interface AnalysisInput {
  ocr_text?: string;
  ocrText?: string;
  color_fractions?: { blue_fraction?: number; blueFraction?: number };
  colorFractions?: { blue_fraction?: number; blueFraction?: number };
  change_vs_baseline?: ChangeSignal;
  changeVsBaseline?: ChangeSignal;
}

interface ChangeSignal {
  changed_fraction?: number;
  changedFraction?: number;
  /** Normalized [minX, minY, maxX, maxY] in [0,1], or null when nothing changed. */
  changed_bbox_norm?: [number, number, number, number] | null;
  changedBboxNorm?: [number, number, number, number] | null;
}

/** Optional context that sharpens generated question wording. */
export interface SuggestContext {
  /** View/surface name, woven into question text (e.g. "the Chat view"). */
  viewName?: string;
  /** Expected copy strings; absence of any becomes a targeted question. */
  expectations?: { requireText?: string[]; forbidText?: string[] };
}

/** Blue over this fraction is a candidate brand-rule violation worth asking about. */
const BLUE_FRACTION_THRESHOLD = 0.02;
/** A diff region larger than this fraction of the frame is worth explaining. */
const CHANGED_FRACTION_THRESHOLD = 0.05;

/**
 * Dev/placeholder strings that should never ship in a screenshot. Matched
 * case-insensitively against OCR text; a hit yields a "is debug text visible?"
 * question naming the found token.
 */
const DEV_STRING_PATTERNS: readonly RegExp[] = [
  /lorem ipsum/i,
  /placeholder/i,
  /\bTODO\b/,
  /\bFIXME\b/,
  /undefined/i,
  /\bNaN\b/,
  /\[object Object\]/i,
  /localhost/i,
  /test123/i,
];

function subject(context: SuggestContext | undefined): string {
  return context?.viewName
    ? `the ${context.viewName} screenshot`
    : "the screenshot";
}

function pct(fraction: number): string {
  return `${(fraction * 100).toFixed(1)}%`;
}

/**
 * Generate question drafts from analysis anomalies. Returns a stable, ordered
 * list with deterministic ids (`q-blue`, `q-diff`, `q-dev-<n>`, `q-missing-<n>`,
 * `q-forbidden-<n>`); empty when the analysis shows nothing worth asking. The
 * caller merges these with any hand-written `-q` questions.
 */
export function suggestQuestions(
  analysis: AnalysisInput,
  context?: SuggestContext,
): VisionQuestion[] {
  const questions: VisionQuestion[] = [];
  const where = subject(context);

  const blue =
    analysis.color_fractions?.blue_fraction ??
    analysis.color_fractions?.blueFraction ??
    analysis.colorFractions?.blue_fraction ??
    analysis.colorFractions?.blueFraction;
  if (blue !== undefined && blue > BLUE_FRACTION_THRESHOLD) {
    questions.push({
      id: "q-blue",
      question:
        `Analysis measured ${pct(blue)} blue pixels in ${where}, above the ` +
        "brand threshold (orange is the only accent; blue is disallowed). Is a " +
        "blue-styled UI element visible, and if so what is it?",
      expected: "no",
    });
  }

  const change = analysis.change_vs_baseline ?? analysis.changeVsBaseline;
  const changedFraction = change?.changed_fraction ?? change?.changedFraction;
  const bbox = change?.changed_bbox_norm ?? change?.changedBboxNorm;
  if (
    changedFraction !== undefined &&
    changedFraction > CHANGED_FRACTION_THRESHOLD &&
    bbox
  ) {
    const [minX, minY, maxX, maxY] = bbox;
    questions.push({
      id: "q-diff",
      question:
        `Compared to the baseline, ${pct(changedFraction)} of ${where} changed, ` +
        `concentrated in the region from (${minX.toFixed(2)}, ${minY.toFixed(2)}) ` +
        `to (${maxX.toFixed(2)}, ${maxY.toFixed(2)}) in normalized coordinates. ` +
        "What UI element occupies that region and what changed about it?",
    });
  }

  const ocr = analysis.ocr_text ?? analysis.ocrText ?? "";
  const found = DEV_STRING_PATTERNS.map((re) => ocr.match(re)?.[0]).filter(
    (m): m is string => m !== undefined && m !== null,
  );
  found.forEach((token, index) => {
    questions.push({
      id: `q-dev-${index}`,
      question:
        `OCR found the string "${token}" in ${where}, which looks like ` +
        "placeholder or debug text. Is that text actually rendered and visible " +
        "to the user (not, e.g., a tooltip or off-screen)?",
      expected: "no",
    });
  });

  (context?.expectations?.requireText ?? []).forEach((text, index) => {
    if (!ocr.toLowerCase().includes(text.toLowerCase())) {
      questions.push({
        id: `q-missing-${index}`,
        question:
          `The copy "${text}" was expected but OCR did not find it in ${where}. ` +
          "Is that text visible anywhere in the screenshot?",
        expected: "yes",
      });
    }
  });

  (context?.expectations?.forbidText ?? []).forEach((text, index) => {
    if (ocr.toLowerCase().includes(text.toLowerCase())) {
      questions.push({
        id: `q-forbidden-${index}`,
        question:
          `The copy "${text}" should not appear but OCR found it in ${where}. ` +
          "Is that text actually visible to the user?",
        expected: "no",
      });
    }
  });

  return questions;
}
