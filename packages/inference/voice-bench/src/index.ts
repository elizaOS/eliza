/**
 * Public surface of @elizaos/voice-bench.
 *
 * Consumers import from this barrel:
 *
 *   import { runBench, MockPipelineDriver, evaluateGates } from "@elizaos/voice-bench";
 *
 * Per AGENTS.md evidence-or-it-didn't-happen rule, any optimization PR
 * touching the voice loop ships a JSON run from this harness as proof.
 */

export * from "./types.ts";
export {
  loadWav,
  decodeWav,
  encodeWav,
  SyntheticAudioSource,
  FRAME_SAMPLES_16K,
  FRAME_DURATION_MS_16K,
} from "./audio-source.ts";
export { MetricsCollector, percentile } from "./metrics.ts";
export {
  generateAllFixtures,
  generateSilence,
  generateShortUtterance,
  generateLongUtterance,
  generateFalseEosUtterance,
  generateBargeInOverlay,
  writeFixtureWav,
  FIXTURE_SAMPLE_RATE,
} from "./fixtures.ts";
export {
  buildScenarios,
  SCENARIO_IDS,
  isScenarioId,
} from "./scenarios.ts";
export type { ScenarioId, ScenarioBuild } from "./scenarios.ts";
export { runBench, parseCliArgs } from "./runner.ts";
export type { RunBenchOpts, ParsedCliArgs } from "./runner.ts";
export {
  evaluateGates,
  aggregate,
  DEFAULT_GATES,
} from "./gates.ts";
export type { RegressionGates, EvaluateGatesOpts } from "./gates.ts";
export { MockPipelineDriver } from "./mock-driver.ts";
export type { MockPipelineDriverOpts } from "./mock-driver.ts";
