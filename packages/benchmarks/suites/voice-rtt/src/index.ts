/**
 * Public exports for the voice round-trip benchmark package.
 */

export { loadCorpus, validateCorpus } from "./corpus.ts";
export {
  deriveStages,
  evaluateGates,
  GATE_TARGETS,
  percentile,
  stageAttribution,
  summarize,
  summarizeStages,
} from "./metrics.ts";
export {
  buildReport,
  redactReport,
  renderJson,
  renderMarkdown,
} from "./report.ts";
export { runBenchmark } from "./runner.ts";
export type * from "./types.ts";
