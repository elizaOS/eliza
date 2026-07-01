/**
 * Browser benchmark harness (#9476) — a MiniWoB++-style web-interaction
 * benchmark wired through the real BROWSER command surface. This is the
 * plugin-browser analog of `plugin-computeruse/src/osworld/`.
 */

export {
  BrowserBenchmarkAdapter,
  type BrowserBenchmarkAdapterConfig,
  createWorkspaceBenchmarkExecutor,
} from "./adapter.js";
export {
  type ChromiumBenchmarkEngine,
  createChromiumBenchmarkEngine,
  createChromiumBenchmarkExecutor,
  launchChromiumBenchmarkBrowser,
  resolveChromiumExecutable,
  resolveChromiumExecutablePath,
  resolveChromiumHeadlessShellExecutablePath,
} from "./chromium-executor.js";
export {
  EXTERNAL_DATASET_ORIGIN,
  EXTERNAL_WEB_DATASET_FIXTURE,
  EXTERNAL_WEB_DATASET_TASKS,
  type ExternalDatasetFamily,
  type ExternalDatasetRecord,
  type ExternalDatasetRewardCheck,
  type ExternalDatasetRoute,
  externalDatasetRecordToTask,
} from "./external-dataset.js";
export {
  type BenchmarkPolicy,
  type BenchmarkPolicyInput,
  NoopPolicy,
  OraclePolicy,
  WrongPolicy,
} from "./policy.js";
export {
  type BenchmarkRunOptions,
  runBenchmarkSuite,
  runEpisode,
} from "./runner.js";
export { getTaskById, MINIWOB_TASKS, WOB_ORIGIN } from "./tasks.js";
export type {
  BenchmarkAction,
  BenchmarkActionType,
  BenchmarkEpisodeResult,
  BenchmarkObservation,
  BenchmarkRewardContext,
  BenchmarkStepResult,
  BenchmarkSuiteReport,
  BenchmarkTask,
  BrowserCommandExecutor,
} from "./types.js";
export {
  type Box,
  centerGrounder,
  cornerGrounder,
  type Grounder,
  type GroundingSample,
  type GroundingSampleResult,
  type GroundingScore,
  type Point,
  pointInBox,
  scoreWebGrounding,
  WEB_GROUNDING_TASKS,
  type WebGroundingTask,
} from "./web-grounding.js";
