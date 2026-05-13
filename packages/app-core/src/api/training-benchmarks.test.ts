/**
 * Integration tests for the training-benchmarks read API (gap M2 / W0-X5).
 *
 * These exercise the HTTP dispatcher against a real on-disk SQLite database
 * (the same one the Python ResultsStore writes). The schema is duplicated
 * inline here — not imported — so the test pins the contract independently
 * of the Python module's evolution.
 */

import fs from "node:fs";
import * as http from "node:http";
import { Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CompatRuntimeState } from "./compat-route-shared";
import {
  type BenchmarkCompareResponse,
  type BenchmarkScoresResponse,
  ELIZA_BENCHMARK_COMPARE_SCHEMA,
  ELIZA_BENCHMARK_SCORES_SCHEMA,
  handleTrainingBenchmarksRoute,
  openBenchmarkResultsReader,
  resolveBenchmarkResultsDbPath,
} from "./training-benchmarks";

const STATE: CompatRuntimeState = {
  current: null,
  pendingAgentName: null,
  pendingRestartReasons: [],
};

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS benchmark_runs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    model_id        TEXT    NOT NULL,
    benchmark       TEXT    NOT NULL,
    score           REAL    NOT NULL,
    ts              INTEGER NOT NULL,
    dataset_version TEXT    NOT NULL,
    code_commit     TEXT    NOT NULL,
    raw_json        TEXT    NOT NULL
);
`;

interface FakeRes {
  res: http.ServerResponse;
  body<T>(): T;
  text(): string;
  status(): number;
}

function fakeRes(): FakeRes {
  let bodyText = "";
  const req = new http.IncomingMessage(new Socket());
  const res = new http.ServerResponse(req);
  res.statusCode = 200;
  res.setHeader = () => res;
  res.end = ((chunk?: string | Buffer) => {
    if (typeof chunk === "string") bodyText += chunk;
    else if (chunk) bodyText += chunk.toString("utf8");
    return res;
  }) as typeof res.end;
  return {
    res,
    body<T>(): T {
      return JSON.parse(bodyText) as T;
    },
    text() {
      return bodyText;
    },
    status() {
      return res.statusCode;
    },
  };
}

function fakeReq(opts: {
  method?: string;
  pathname: string;
  query?: Record<string, string | undefined>;
  ip?: string;
  headers?: http.IncomingHttpHeaders;
}): http.IncomingMessage {
  const req = new http.IncomingMessage(new Socket());
  req.method = opts.method ?? "GET";
  const params = new URLSearchParams();
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) params.set(k, v);
    }
  }
  const search = params.toString();
  req.url = search ? `${opts.pathname}?${search}` : opts.pathname;
  req.headers = {
    host: "localhost:31337",
    ...(opts.headers ?? {}),
  };
  Object.defineProperty(req.socket, "remoteAddress", {
    value: opts.ip ?? "127.0.0.1",
    configurable: true,
  });
  return req;
}

interface SeedRow {
  modelId: string;
  benchmark: string;
  score: number;
  ts: number;
  datasetVersion?: string;
  codeCommit?: string;
  rawJson?: string;
}

function seedDb(dbPath: string, rows: SeedRow[]): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(SCHEMA_SQL);
  const stmt = db.prepare(
    `INSERT INTO benchmark_runs (
       model_id, benchmark, score, ts, dataset_version, code_commit, raw_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    stmt.run(
      r.modelId,
      r.benchmark,
      r.score,
      r.ts,
      r.datasetVersion ?? "2024-12",
      r.codeCommit ?? "abc1234",
      r.rawJson ?? "{}",
    );
  }
  db.close();
}

describe("resolveBenchmarkResultsDbPath", () => {
  const ORIGINAL_OVERRIDE = process.env.ELIZA_BENCHMARK_RESULTS_DB;

  afterEach(() => {
    if (ORIGINAL_OVERRIDE === undefined) {
      delete process.env.ELIZA_BENCHMARK_RESULTS_DB;
    } else {
      process.env.ELIZA_BENCHMARK_RESULTS_DB = ORIGINAL_OVERRIDE;
    }
  });

  it("defaults to ~/.eliza/benchmarks/results.db", () => {
    expect(
      resolveBenchmarkResultsDbPath({
        ELIZA_BENCHMARK_RESULTS_DB: undefined,
      } as NodeJS.ProcessEnv),
    ).toBe(path.join(os.homedir(), ".eliza", "benchmarks", "results.db"));
  });

  it("honors ELIZA_BENCHMARK_RESULTS_DB", () => {
    expect(
      resolveBenchmarkResultsDbPath({
        ELIZA_BENCHMARK_RESULTS_DB: "/tmp/custom.db",
      } as NodeJS.ProcessEnv),
    ).toBe(path.resolve("/tmp/custom.db"));
  });

  it("expands ~ in the override", () => {
    expect(
      resolveBenchmarkResultsDbPath({
        ELIZA_BENCHMARK_RESULTS_DB: "~/custom.db",
      } as NodeJS.ProcessEnv),
    ).toBe(path.resolve(path.join(os.homedir(), "custom.db")));
  });
});

describe("training-benchmarks read API", () => {
  let tmpDir: string;
  let dbPath: string;

  const ORIGINAL_API_TOKEN = process.env.ELIZA_API_TOKEN;
  const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

  beforeEach(() => {
    // Loopback-without-token works only when no API token is configured.
    delete process.env.ELIZA_API_TOKEN;
    process.env.NODE_ENV = "test";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-bench-db-"));
    dbPath = path.join(tmpDir, "results.db");
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (ORIGINAL_API_TOKEN === undefined) {
      delete process.env.ELIZA_API_TOKEN;
    } else {
      process.env.ELIZA_API_TOKEN = ORIGINAL_API_TOKEN;
    }
    if (ORIGINAL_NODE_ENV === undefined) {
      delete process.env.NODE_ENV;
    } else {
      process.env.NODE_ENV = ORIGINAL_NODE_ENV;
    }
  });

  // -- routing --------------------------------------------------------------

  it("does not handle unrelated paths", async () => {
    const res = fakeRes();
    const handled = await handleTrainingBenchmarksRoute(
      fakeReq({ pathname: "/api/something-else" }),
      res.res,
      STATE,
      { dbPath },
    );
    expect(handled).toBe(false);
  });

  it("rejects non-GET methods", async () => {
    const res = fakeRes();
    const handled = await handleTrainingBenchmarksRoute(
      fakeReq({
        method: "POST",
        pathname: "/api/training/benchmarks/scores",
      }),
      res.res,
      STATE,
      { dbPath },
    );
    expect(handled).toBe(true);
    expect(res.status()).toBe(405);
  });

  // -- /scores --------------------------------------------------------------

  it("scores: returns empty runs and dbReady=false when the DB does not exist", async () => {
    const res = fakeRes();
    await handleTrainingBenchmarksRoute(
      fakeReq({
        pathname: "/api/training/benchmarks/scores",
        query: { model_id: "eliza-1-1_7b", benchmark: "mmlu" },
      }),
      res.res,
      STATE,
      { dbPath },
    );
    expect(res.status()).toBe(200);
    const body = res.body<BenchmarkScoresResponse>();
    expect(body.schema).toBe(ELIZA_BENCHMARK_SCORES_SCHEMA);
    expect(body.modelId).toBe("eliza-1-1_7b");
    expect(body.benchmark).toBe("mmlu");
    expect(body.dbReady).toBe(false);
    expect(body.runs).toEqual([]);
  });

  it("scores: returns history newest-first when seeded", async () => {
    seedDb(dbPath, [
      { modelId: "m", benchmark: "mmlu", score: 0.6, ts: 1_000 },
      { modelId: "m", benchmark: "mmlu", score: 0.7, ts: 2_000 },
      { modelId: "m", benchmark: "mmlu", score: 0.65, ts: 1_500 },
    ]);
    const res = fakeRes();
    await handleTrainingBenchmarksRoute(
      fakeReq({
        pathname: "/api/training/benchmarks/scores",
        query: { model_id: "m", benchmark: "mmlu" },
      }),
      res.res,
      STATE,
      { dbPath },
    );
    expect(res.status()).toBe(200);
    const body = res.body<BenchmarkScoresResponse>();
    expect(body.dbReady).toBe(true);
    expect(body.runs.map((r) => r.score)).toEqual([0.7, 0.65, 0.6]);
    expect(body.runs[0].ts).toBe(2_000);
  });

  it("scores: filters by model and benchmark", async () => {
    seedDb(dbPath, [
      { modelId: "m1", benchmark: "mmlu", score: 0.5, ts: 1_000 },
      { modelId: "m2", benchmark: "mmlu", score: 0.9, ts: 1_000 },
      { modelId: "m1", benchmark: "humaneval", score: 0.7, ts: 1_000 },
    ]);
    const res = fakeRes();
    await handleTrainingBenchmarksRoute(
      fakeReq({
        pathname: "/api/training/benchmarks/scores",
        query: { model_id: "m1", benchmark: "mmlu" },
      }),
      res.res,
      STATE,
      { dbPath },
    );
    const body = res.body<BenchmarkScoresResponse>();
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].score).toBe(0.5);
    expect(body.runs[0].modelId).toBe("m1");
    expect(body.runs[0].benchmark).toBe("mmlu");
  });

  it("scores: respects the limit query param", async () => {
    seedDb(
      dbPath,
      Array.from({ length: 5 }, (_, i) => ({
        modelId: "m",
        benchmark: "b",
        score: i,
        ts: 1_000 + i,
      })),
    );
    const res = fakeRes();
    await handleTrainingBenchmarksRoute(
      fakeReq({
        pathname: "/api/training/benchmarks/scores",
        query: { model_id: "m", benchmark: "b", limit: "2" },
      }),
      res.res,
      STATE,
      { dbPath },
    );
    const body = res.body<BenchmarkScoresResponse>();
    expect(body.runs).toHaveLength(2);
    expect(body.runs.map((r) => r.score)).toEqual([4, 3]);
  });

  it("scores: rejects missing model_id", async () => {
    const res = fakeRes();
    await handleTrainingBenchmarksRoute(
      fakeReq({
        pathname: "/api/training/benchmarks/scores",
        query: { benchmark: "mmlu" },
      }),
      res.res,
      STATE,
      { dbPath },
    );
    expect(res.status()).toBe(400);
  });

  it("scores: rejects missing benchmark", async () => {
    const res = fakeRes();
    await handleTrainingBenchmarksRoute(
      fakeReq({
        pathname: "/api/training/benchmarks/scores",
        query: { model_id: "m" },
      }),
      res.res,
      STATE,
      { dbPath },
    );
    expect(res.status()).toBe(400);
  });

  it.each([
    [
      "dangerous model_id with semicolons",
      { model_id: "m;DROP", benchmark: "mmlu" },
    ],
    ["dangerous model_id with spaces", { model_id: "m x", benchmark: "mmlu" }],
    ["dangerous benchmark with quotes", { model_id: "m", benchmark: 'b"x' }],
    ["benchmark with slash", { model_id: "m", benchmark: "b/c" }],
  ])("scores: rejects %s", async (_label, query) => {
    const res = fakeRes();
    await handleTrainingBenchmarksRoute(
      fakeReq({ pathname: "/api/training/benchmarks/scores", query }),
      res.res,
      STATE,
      { dbPath },
    );
    expect(res.status()).toBe(400);
  });

  // -- /compare -------------------------------------------------------------

  it("compare: returns a/b/delta and dbReady=true when both sides have runs", async () => {
    seedDb(dbPath, [
      { modelId: "a", benchmark: "mmlu", score: 0.75, ts: 1_000 },
      { modelId: "b", benchmark: "mmlu", score: 0.6, ts: 1_000 },
    ]);
    const res = fakeRes();
    await handleTrainingBenchmarksRoute(
      fakeReq({
        pathname: "/api/training/benchmarks/compare",
        query: { a: "a", b: "b", benchmark: "mmlu" },
      }),
      res.res,
      STATE,
      { dbPath },
    );
    expect(res.status()).toBe(200);
    const body = res.body<BenchmarkCompareResponse>();
    expect(body.schema).toBe(ELIZA_BENCHMARK_COMPARE_SCHEMA);
    expect(body.dbReady).toBe(true);
    expect(body.a?.score).toBe(0.75);
    expect(body.b?.score).toBe(0.6);
    expect(body.delta).toBeCloseTo(0.15, 8);
  });

  it("compare: uses the most recent score for each side", async () => {
    seedDb(dbPath, [
      { modelId: "a", benchmark: "mmlu", score: 0.5, ts: 1_000 },
      { modelId: "a", benchmark: "mmlu", score: 0.8, ts: 2_000 },
      { modelId: "b", benchmark: "mmlu", score: 0.4, ts: 1_500 },
    ]);
    const res = fakeRes();
    await handleTrainingBenchmarksRoute(
      fakeReq({
        pathname: "/api/training/benchmarks/compare",
        query: { a: "a", b: "b", benchmark: "mmlu" },
      }),
      res.res,
      STATE,
      { dbPath },
    );
    const body = res.body<BenchmarkCompareResponse>();
    expect(body.a?.score).toBe(0.8);
    expect(body.b?.score).toBe(0.4);
    expect(body.delta).toBeCloseTo(0.4, 8);
  });

  it("compare: returns null delta when one side is missing", async () => {
    seedDb(dbPath, [
      { modelId: "a", benchmark: "mmlu", score: 0.5, ts: 1_000 },
    ]);
    const res = fakeRes();
    await handleTrainingBenchmarksRoute(
      fakeReq({
        pathname: "/api/training/benchmarks/compare",
        query: { a: "a", b: "missing", benchmark: "mmlu" },
      }),
      res.res,
      STATE,
      { dbPath },
    );
    const body = res.body<BenchmarkCompareResponse>();
    expect(body.a).not.toBeNull();
    expect(body.b).toBeNull();
    expect(body.delta).toBeNull();
  });

  it("compare: empty DB returns nulls and dbReady=false", async () => {
    const res = fakeRes();
    await handleTrainingBenchmarksRoute(
      fakeReq({
        pathname: "/api/training/benchmarks/compare",
        query: { a: "a", b: "b", benchmark: "mmlu" },
      }),
      res.res,
      STATE,
      { dbPath },
    );
    const body = res.body<BenchmarkCompareResponse>();
    expect(body.dbReady).toBe(false);
    expect(body.a).toBeNull();
    expect(body.b).toBeNull();
    expect(body.delta).toBeNull();
  });

  it("compare: rejects missing a/b/benchmark", async () => {
    const cases = [
      { b: "b", benchmark: "mmlu" },
      { a: "a", benchmark: "mmlu" },
      { a: "a", b: "b" },
    ];
    for (const query of cases) {
      const res = fakeRes();
      await handleTrainingBenchmarksRoute(
        fakeReq({ pathname: "/api/training/benchmarks/compare", query }),
        res.res,
        STATE,
        { dbPath },
      );
      expect(res.status()).toBe(400);
    }
  });

  it("unknown subpath returns 404", async () => {
    const res = fakeRes();
    await handleTrainingBenchmarksRoute(
      fakeReq({
        pathname: "/api/training/benchmarks/whoami",
        query: { x: "y" },
      }),
      res.res,
      STATE,
      { dbPath },
    );
    expect(res.status()).toBe(404);
  });
});

describe("openBenchmarkResultsReader", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-bench-reader-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns a non-ready reader when the file does not exist", () => {
    const reader = openBenchmarkResultsReader(path.join(tmpDir, "missing.db"));
    expect(reader.ready).toBe(false);
    expect(
      reader.getHistory({ modelId: "m", benchmark: "b", limit: 10 }),
    ).toEqual([]);
    expect(reader.getLatest({ modelId: "m", benchmark: "b" })).toBeNull();
    reader.close(); // must not throw
  });

  it("returns rows in newest-first order for a seeded DB", () => {
    const dbPath = path.join(tmpDir, "results.db");
    seedDb(dbPath, [
      { modelId: "m", benchmark: "b", score: 0.1, ts: 100 },
      { modelId: "m", benchmark: "b", score: 0.9, ts: 200 },
    ]);
    const reader = openBenchmarkResultsReader(dbPath);
    expect(reader.ready).toBe(true);
    const history = reader.getHistory({
      modelId: "m",
      benchmark: "b",
      limit: 10,
    });
    expect(history.map((r) => r.score)).toEqual([0.9, 0.1]);
    expect(reader.getLatest({ modelId: "m", benchmark: "b" })?.score).toBe(0.9);
    reader.close();
  });
});
