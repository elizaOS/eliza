/**
 * Public surface for `@elizaos/bench-vision-language`.
 */
export { ChartQaAdapter, predictChartQa } from "./adapters/chartqa_adapter.ts";
export type { ChartQaPayload } from "./adapters/chartqa_adapter.ts";
export { DocVqaAdapter, predictDocVqa } from "./adapters/docvqa_adapter.ts";
export type { DocVqaPayload } from "./adapters/docvqa_adapter.ts";
export {
  OSWorldAdapter,
  predictOSWorld,
  parseActionList,
  actionListPrompt,
} from "./adapters/osworld_adapter.ts";
export type { OSWorldPayload } from "./adapters/osworld_adapter.ts";
export {
  ScreenSpotAdapter,
  predictScreenSpot,
  parseClickFromText,
  groundingPrompt,
} from "./adapters/screenspot_adapter.ts";
export type { ScreenSpotPayload } from "./adapters/screenspot_adapter.ts";
export { TextVqaAdapter, predictTextVqa } from "./adapters/textvqa_adapter.ts";
export type { TextVqaPayload } from "./adapters/textvqa_adapter.ts";
export {
  anls,
  bboxIoU,
  clickHit,
  exactMatch,
  iouHit,
  levenshtein,
  normaliseAnswer,
  osworldStepMatch,
  pointInBBox,
  relaxedNumeric,
  vqaSoftScore,
} from "./scorers/index.ts";
export { lookupBaseline, runOneBenchmark } from "./runner.ts";
export type { RunOneArgs } from "./runner.ts";
export { createStubRuntime, resolveRuntime } from "./runtime-resolver.ts";
export type {
  BBox,
  BaselineEntry,
  BenchReport,
  BenchmarkAdapter,
  BenchmarkName,
  Eliza1TierId,
  Point,
  PredictedAction,
  Prediction,
  Sample,
  SampleResult,
  VisionRuntime,
} from "./types.ts";
