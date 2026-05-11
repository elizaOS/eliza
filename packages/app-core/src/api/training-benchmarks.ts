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

import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ensureRouteAuthorized } from "./auth.ts";
import type { CompatRuntimeState } from "./compat-route-shared";
import { sendJson, sendJsonError } from "./response";

const ROUTE_PREFIX = "/api/training/benchmarks";
const ROUTE_SCORES = `${ROUTE_PREFIX}/scores`;
const ROUTE_COMPARE = `${ROUTE_PREFIX}/compare`;

const DEFAULT_HISTORY_LIMIT = 100;
const MAX_HISTORY_LIMIT = 1000;

// Match the Python validator: [A-Za-z0-9._:/-], 1..256 chars. Wider than secret
// keys because model ids contain slashes and colons in some catalogs.
const SAFE_ID_RE = /^[A-Za-z0-9._:/-]{1,256}$/;
const SAFE_BENCHMARK_RE = /^[A-Za-z0-9_.-]{1,128}$/;

// ---------------------------------------------------------------------------
// DTOs (response shapes)
// ---------------------------------------------------------------------------

export const ELIZA_BENCHMARK_SCORES_SCHEMA =
  "elizaos.training.benchmark-scores/v1" as const;
export const ELIZA_BENCHMARK_COMPARE_SCHEMA =
  "elizaos.training.benchmark-compare/v1" as const;

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

// ---------------------------------------------------------------------------
// Storage location resolver
// ---------------------------------------------------------------------------

export function resolveBenchmarkResultsDbPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const override = env.ELIZA_BENCHMARK_RESULTS_DB?.trim();
  if (override && override.length > 0) {
    return path.resolve(expandUserHome(override));
  }
  return path.join(os.homedir(), ".eliza", "benchmarks", "results.db");
}

function expandUserHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

// ---------------------------------------------------------------------------
// Reader — opens the SQLite file in read-only mode for each request
// ---------------------------------------------------------------------------

interface DbRunRow {
  id: number | bigint;
  model_id: string;
  benchmark: string;
  score: number;
  ts: number | bigint;
  dataset_version: string;
  code_commit: string;
}

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

export function openBenchmarkResultsReader(
  dbPath: string,
): BenchmarkResultsReader {
  if (!fs.existsSync(dbPath)) {
    return {
      ready: false,
      getHistory: () => [],
      getLatest: () => null,
      close: () => {},
    };
  }

  const db = new DatabaseSync(dbPath, { readOnly: true });
  const historyStmt = db.prepare(
    `SELECT id, model_id, benchmark, score, ts, dataset_version, code_commit
       FROM benchmark_runs
      WHERE model_id = ? AND benchmark = ?
      ORDER BY ts DESC, id DESC
      LIMIT ?`,
  );
  const latestStmt = db.prepare(
    `SELECT id, model_id, benchmark, score, ts, dataset_version, code_commit
       FROM benchmark_runs
      WHERE model_id = ? AND benchmark = ?
      ORDER BY ts DESC, id DESC
      LIMIT 1`,
  );

  return {
    ready: true,
    getHistory({ modelId, benchmark, limit }): BenchmarkRunDTO[] {
      const rows = historyStmt.all(modelId, benchmark, limit) as DbRunRow[];
      return rows.map(rowToDto);
    },
    getLatest({ modelId, benchmark }): BenchmarkRunDTO | null {
      const rows = latestStmt.all(modelId, benchmark) as DbRunRow[];
      if (rows.length === 0) return null;
      return rowToDto(rows[0]);
    },
    close(): void {
      db.close();
    },
  };
}

function rowToDto(row: DbRunRow): BenchmarkRunDTO {
  return {
    id: Number(row.id),
    modelId: row.model_id,
    benchmark: row.benchmark,
    score: row.score,
    ts: Number(row.ts),
    datasetVersion: row.dataset_version,
    codeCommit: row.code_commit,
  };
}

// ---------------------------------------------------------------------------
// Query-parameter helpers
// ---------------------------------------------------------------------------

function readModelId(url: URL, name: string): string | null {
  const raw = url.searchParams.get(name);
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return SAFE_ID_RE.test(trimmed) ? trimmed : null;
}

function readBenchmark(url: URL): string | null {
  const raw = url.searchParams.get("benchmark");
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  return SAFE_BENCHMARK_RE.test(trimmed) ? trimmed : null;
}

function readLimit(url: URL): number {
  const raw = url.searchParams.get("limit");
  if (raw == null || raw.trim().length === 0) return DEFAULT_HISTORY_LIMIT;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    return DEFAULT_HISTORY_LIMIT;
  }
  return Math.min(n, MAX_HISTORY_LIMIT);
}

// ---------------------------------------------------------------------------
// Route dispatcher
// ---------------------------------------------------------------------------

export interface TrainingBenchmarksRouteOptions {
  /** Override the DB path. Tests use this. */
  dbPath?: string;
  /**
   * Open a reader. Tests can inject a fake to avoid touching disk.
   * Defaults to {@link openBenchmarkResultsReader}.
   */
  openReader?: (dbPath: string) => BenchmarkResultsReader;
}

export async function handleTrainingBenchmarksRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  state: CompatRuntimeState,
  options: TrainingBenchmarksRouteOptions = {},
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith(ROUTE_PREFIX)) {
    return false;
  }

  const method = (req.method ?? "GET").toUpperCase();

  if (method !== "GET") {
    sendJsonError(res, 405, "method not allowed");
    return true;
  }

  if (!(await ensureRouteAuthorized(req, res, state))) {
    return true;
  }

  const dbPath = options.dbPath ?? resolveBenchmarkResultsDbPath();
  const openReader = options.openReader ?? openBenchmarkResultsReader;

  if (url.pathname === ROUTE_SCORES) {
    return handleScores(res, url, dbPath, openReader);
  }
  if (url.pathname === ROUTE_COMPARE) {
    return handleCompare(res, url, dbPath, openReader);
  }

  sendJsonError(res, 404, "not found");
  return true;
}

function handleScores(
  res: http.ServerResponse,
  url: URL,
  dbPath: string,
  openReader: (path: string) => BenchmarkResultsReader,
): boolean {
  const modelId = readModelId(url, "model_id");
  const benchmark = readBenchmark(url);
  if (!modelId) {
    sendJsonError(res, 400, "missing or invalid model_id");
    return true;
  }
  if (!benchmark) {
    sendJsonError(res, 400, "missing or invalid benchmark");
    return true;
  }

  const limit = readLimit(url);
  const reader = openReader(dbPath);
  const runs = reader.getHistory({ modelId, benchmark, limit });
  const dbReady = reader.ready;
  reader.close();

  const body: BenchmarkScoresResponse = {
    schema: ELIZA_BENCHMARK_SCORES_SCHEMA,
    modelId,
    benchmark,
    dbReady,
    runs,
  };
  sendJson(res, 200, body);
  return true;
}

function handleCompare(
  res: http.ServerResponse,
  url: URL,
  dbPath: string,
  openReader: (path: string) => BenchmarkResultsReader,
): boolean {
  const modelA = readModelId(url, "a");
  const modelB = readModelId(url, "b");
  const benchmark = readBenchmark(url);
  if (!modelA) {
    sendJsonError(res, 400, "missing or invalid a");
    return true;
  }
  if (!modelB) {
    sendJsonError(res, 400, "missing or invalid b");
    return true;
  }
  if (!benchmark) {
    sendJsonError(res, 400, "missing or invalid benchmark");
    return true;
  }

  const reader = openReader(dbPath);
  const aRun = reader.getLatest({ modelId: modelA, benchmark });
  const bRun = reader.getLatest({ modelId: modelB, benchmark });
  const dbReady = reader.ready;
  reader.close();

  const delta =
    aRun !== null && bRun !== null ? aRun.score - bRun.score : null;

  const body: BenchmarkCompareResponse = {
    schema: ELIZA_BENCHMARK_COMPARE_SCHEMA,
    benchmark,
    modelA,
    modelB,
    dbReady,
    a: aRun,
    b: bRun,
    delta,
  };
  sendJson(res, 200, body);
  return true;
}
