/** Public surface of the analyzer registry: types, analyzers, engines, runner. */

export {
  type AriaDiffEntry,
  type AriaNode,
  type AriaTreeData,
  ariaTreeAnalyzer,
  diffAriaSnapshots,
  normalizeAriaSnapshot,
  type PruneOptions,
  parseAriaSnapshot,
  pruneAriaSnapshot,
} from "./aria.ts";
export {
  BRAND_THRESHOLDS,
  type BrandCheck,
  type BrandData,
  brandColorFractions,
  brandRulesAnalyzer,
  evaluateBrand,
} from "./brand.ts";
export {
  CORNER_POSITIONS,
  type CornerPosition,
  type CornerSwatch,
  type CornersData,
  colorCornersAnalyzer,
  colorPaletteAnalyzer,
  cornerSwatches,
  dominantPalette,
  type PaletteData,
  type PaletteSwatch,
} from "./color.ts";
export {
  type ColorBucket,
  type ColorFractions,
  classifyColor,
  colorFractionsFromRaw,
  round4,
} from "./color-math.ts";
export {
  type ChangeData,
  type ChangedRegion,
  changeMetric,
  clusterRegions,
  diffChangeAnalyzer,
  diffRegionAnalyzer,
  evaluateRegionExpectations,
  type RegionAssertion,
  type RegionDiffData,
} from "./diff.ts";
export {
  type AnalyzerExecutor,
  INLINE_EXECUTOR,
  InlineExecutor,
  runAnalyzerInline,
} from "./executor.ts";
export {
  extractKeyframes,
  ffmpegAvailable,
  type KeyframeRecord,
  type KeyframesData,
  slugForVideo,
  videoKeyframesAnalyzer,
} from "./keyframes.ts";
export {
  AppleVisionOcrEngine,
  defaultServeStatePath,
  type OcrAvailable,
  type OcrEngine,
  type OcrGroundedRegion,
  type OcrRecognition,
  type OcrUnavailable,
  parseGroundingDecorations,
  TesseractOcrEngine,
  UNLIMITED_OCR_PROMPT,
  UnlimitedOcrEngine,
} from "./ocr/engines.ts";
export {
  makeOcrAnalyzer,
  type OcrData,
  ocrTesseractAnalyzer,
  ocrUnlimitedAnalyzer,
} from "./ocr/ocr.ts";
export {
  hammingDistance,
  isSameScreen,
  type PerceptualHashData,
  perceptualHash,
  perceptualHashAnalyzer,
  SAME_SCREEN_THRESHOLD,
} from "./phash.ts";
export {
  ANALYZERS,
  analyzersForKind,
  analyzersForTier,
  getAnalyzer,
  tierRunnable,
} from "./registry.ts";
export {
  type AnalyzeOptions,
  type AnalyzeResult,
  analyzeArtifacts,
  type SubjectAnalysis,
} from "./runner.ts";
export type {
  AnalysisDocument,
  Analyzer,
  AnalyzerContext,
  AnalyzerExpectations,
  AnalyzerFragment,
  AnalyzerInput,
  AnalyzerResult,
  AnalyzerStatus,
  BaselineResolver,
  EmitArtifact,
  RegionExpectation,
} from "./types.ts";
