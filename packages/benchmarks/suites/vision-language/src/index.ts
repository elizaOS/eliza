/**
 * Public surface for `@elizaos/bench-vision-language`.
 */

export type { ChartQaPayload } from "./adapters/chartqa_adapter.ts";
export { ChartQaAdapter, predictChartQa } from "./adapters/chartqa_adapter.ts";
export type { DocVqaPayload } from "./adapters/docvqa_adapter.ts";
export { DocVqaAdapter, predictDocVqa } from "./adapters/docvqa_adapter.ts";
export type { OSWorldPayload } from "./adapters/osworld_adapter.ts";
export {
  actionListPrompt,
  OSWorldAdapter,
  parseActionList,
  predictOSWorld,
} from "./adapters/osworld_adapter.ts";
export type { ScreenSpotPayload } from "./adapters/screenspot_adapter.ts";
export {
  groundingPrompt,
  parseClickFromText,
  predictScreenSpot,
  ScreenSpotAdapter,
} from "./adapters/screenspot_adapter.ts";
export type { TextVqaPayload } from "./adapters/textvqa_adapter.ts";
export { predictTextVqa, TextVqaAdapter } from "./adapters/textvqa_adapter.ts";
export type { RunOneArgs } from "./runner.ts";
export { lookupBaseline, runOneBenchmark } from "./runner.ts";
export { createStubRuntime, resolveRuntime } from "./runtime-resolver.ts";
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
export type {
  BaselineEntry,
  BBox,
  BenchmarkAdapter,
  BenchmarkName,
  BenchReport,
  Eliza1TierId,
  Point,
  PredictedAction,
  Prediction,
  Sample,
  SampleResult,
  VisionRuntime,
} from "./types.ts";
