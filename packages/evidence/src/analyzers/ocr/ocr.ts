/**
 * OCR analyzers, one per engine. The analyzer body is identical across engines
 * — probe availability, recognize, package the text — so the engine indirection
 * (`engines.ts`) is what distinguishes `ocr.tesseract` (cpu) from `ocr.unlimited`
 * (gpu) from a future `ocr.apple-vision`. Availability is checked first so an
 * absent binary / unset endpoint / unreachable host becomes an honest
 * `skipped-missing-tool` record with the reason, never a fabricated empty read
 * (the visual-qa doctrine: an empty transcript must not read as "no text on
 * screen").
 */

import type { Analyzer, AnalyzerFragment, AnalyzerInput } from "../types.ts";
import {
  type OcrEngine,
  TesseractOcrEngine,
  UnlimitedOcrEngine,
} from "./engines.ts";

/** Payload of a `ran` OCR result. */
export interface OcrData {
  engine: string;
  text: string;
  /** Number of whitespace-delimited tokens in the transcript. */
  words: number;
  /** Engine mean confidence in [0,1] when reported, else null. */
  confidence: number | null;
}

/** Build an OCR analyzer over `engine` at `tier`, named `ocr.<engine.id>`. */
export function makeOcrAnalyzer(
  engine: OcrEngine,
  tier: Analyzer["tier"],
): Analyzer {
  return {
    name: `ocr.${engine.id}`,
    tier,
    kinds: ["screenshot", "keyframe"],
    async analyze(input: AnalyzerInput): Promise<AnalyzerFragment> {
      const availability = await engine.available();
      if (!availability.available) {
        return { status: "skipped-missing-tool", reason: availability.reason };
      }
      const { text, confidence } = await engine.recognize(input.absolutePath);
      const data: OcrData = {
        engine: engine.id,
        text,
        words: text.split(/\s+/).filter(Boolean).length,
        confidence: typeof confidence === "number" ? confidence : null,
      };
      return { status: "ran", data };
    },
  };
}

/** CPU-tier tesseract OCR (ported from visual-qa.mjs). */
export const ocrTesseractAnalyzer: Analyzer = makeOcrAnalyzer(
  new TesseractOcrEngine(),
  "cpu",
);

/** GPU-tier Baidu Unlimited-OCR via the OpenAI-compatible vision service. */
export const ocrUnlimitedAnalyzer: Analyzer = makeOcrAnalyzer(
  new UnlimitedOcrEngine(),
  "gpu",
);
