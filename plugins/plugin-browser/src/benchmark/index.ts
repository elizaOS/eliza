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
  createChromiumBenchmarkExecutor,
  resolveChromiumExecutable,
} from "./chromium-executor.js";
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
