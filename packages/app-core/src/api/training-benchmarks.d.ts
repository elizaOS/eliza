/**
 * Read-only API for the benchmark trending DB scaffolded in W0-X5 (gap M2).
 *
 * The producers — benchmark adapters, the promotion gate, the trajectory-replay
 * harness — are Python (W1-B*). They write to a small SQLite database via
 * `eliza/packages/benchmarks/lib/results_store.py`. This module is the dashboard
 * read-side: it exposes two endpoints that surface per-model history and pairwise
 * comparisons to the Training view in the dashboard without re-running the
 * benchmark.
 *
 * Endpoints
 * =========
 *
 *   GET /api/training/benchmarks/scores?model_id=&benchmark=[&limit=]
 *     Returns `{ runs: BenchmarkRunDTO[] }` — newest-first history for one
 *     (model, benchmark) pair. `limit` defaults to 100, max 1000.
 *
 *   GET /api/training/benchmarks/compare?a=&b=&benchmark=
 *     Returns the latest run for each side plus `delta = a.score - b.score`
 *     (or `null` if either side is missing).
 *
 * Storage location
 * ================
 *
 * The SQLite path follows the Python store's default:
 *   - `ELIZA_BENCHMARK_RESULTS_DB` (env override) if set.
 *   - else `~/.eliza/benchmarks/results.db`.
 *
 * Mode notes
 * ==========
 *
 * - The DB file may not exist when no benchmarks have run yet. In that case
 *   every endpoint returns an empty result — *not* a 5xx. Producers in W1-B*
 *   will populate it.
 * - The schema is locked to v1 in the Python module. Any future migration is
 *   a coordinated change.
 */
import type http from "node:http";
import type { CompatRuntimeState } from "./compat-route-shared";
export declare const ELIZA_BENCHMARK_SCORES_SCHEMA: "elizaos.training.benchmark-scores/v1";
export declare const ELIZA_BENCHMARK_COMPARE_SCHEMA: "elizaos.training.benchmark-compare/v1";
export interface BenchmarkRunDTO {
  id: number;
  modelId: string;
  benchmark: string;
  score: number;
  /** Unix milliseconds, UTC. */
  ts: number;
  datasetVersion: string;
  codeCommit: string;
}
export interface BenchmarkScoresResponse {
  schema: typeof ELIZA_BENCHMARK_SCORES_SCHEMA;
  modelId: string;
  benchmark: string;
  /** Whether the underlying SQLite database file exists. */
  dbReady: boolean;
  runs: BenchmarkRunDTO[];
}
export interface BenchmarkCompareResponse {
  schema: typeof ELIZA_BENCHMARK_COMPARE_SCHEMA;
  benchmark: string;
  modelA: string;
  modelB: string;
  dbReady: boolean;
  a: BenchmarkRunDTO | null;
  b: BenchmarkRunDTO | null;
  /** `a.score - b.score` when both sides have runs; otherwise `null`. */
  delta: number | null;
}
export declare function resolveBenchmarkResultsDbPath(
  env?: NodeJS.ProcessEnv,
): string;
interface BenchmarkResultsReader {
  ready: boolean;
  getHistory(args: {
    modelId: string;
    benchmark: string;
    limit: number;
  }): BenchmarkRunDTO[];
  getLatest(args: {
    modelId: string;
    benchmark: string;
  }): BenchmarkRunDTO | null;
  close(): void;
}
export declare function openBenchmarkResultsReader(
  dbPath: string,
): BenchmarkResultsReader;
export interface TrainingBenchmarksRouteOptions {
  /** Override the DB path. Tests use this. */
  dbPath?: string;
  /**
   * Open a reader. Tests can inject a fake to avoid touching disk.
   * Defaults to {@link openBenchmarkResultsReader}.
   */
  openReader?: (dbPath: string) => BenchmarkResultsReader;
}
export declare function handleTrainingBenchmarksRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
  options?: TrainingBenchmarksRouteOptions,
): Promise<boolean>;
//# sourceMappingURL=training-benchmarks.d.ts.map
