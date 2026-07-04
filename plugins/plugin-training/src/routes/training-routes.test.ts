/**
 * Coverage for the `/api/training/*` route handler (`handleTrainingRoutes`),
 * driving it against an in-memory fake TrainingService — no live backend.
 */
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TrajectoryListResult } from "@elizaos/agent";
import { afterEach, describe, expect, it } from "vitest";
import type { TrainingServiceLike } from "../services/training-service-like.js";
import {
  handleTrainingRoutes,
  type TrainingRouteContext,
} from "./training-routes.js";

type TrajRecord = TrajectoryListResult["trajectories"][number];

/** Build a full TrajectorySummaryRecord from an id (test fixture). */
function trajRecord(id: string, extra: Partial<TrajRecord> = {}): TrajRecord {
  return {
    id,
    agentId: "agent-1",
    source: "test",
    status: "completed",
    startTime: 0,
    endTime: 1,
    durationMs: 1,
    llmCallCount: 0,
    providerAccessCount: 0,
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    createdAt: "1970-01-01T00:00:00.000Z",
    ...extra,
  };
}

/** Wrap records in a full TrajectoryListResult (offset/limit are required). */
function listResult(
  trajectories: TrajRecord[],
  total = trajectories.length,
): TrajectoryListResult {
  return { trajectories, total, offset: 0, limit: 50 };
}

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "training-routes-"));
  tempDirs.push(dir);
  return dir;
}

function trainingService(): TrainingServiceLike {
  return {
    getStatus: () => ({}),
    listTrajectories: async () => listResult([], 0),
    getTrajectoryById: async () => null,
    listDatasets: () => [],
    buildDataset: async () => ({}),
    listJobs: () => [],
    startTrainingJob: async () => ({}),
    getJob: () => null,
    cancelJob: async () => ({}),
    listModels: () => [],
    importModelToOllama: async () => ({}),
    activateModel: async () => ({}),
    benchmarkModel: async () => ({}),
  } as TrainingServiceLike;
}

async function invokeActionBenchmarkRoute(
  body: Record<string, unknown>,
): Promise<{ status: number; payload: unknown }> {
  const captured: { status: number; payload: unknown } = {
    status: 200,
    payload: undefined,
  };
  const ctx: TrainingRouteContext = {
    req: {
      url: "/api/training/benchmarks/action-selection/run",
      headers: { host: "localhost" },
    } as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method: "POST",
    pathname: "/api/training/benchmarks/action-selection/run",
    runtime: null,
    trainingService: trainingService(),
    isLoopbackHost: () => true,
    readJsonBody: async <T extends object>() => body as T,
    json: (_res, data, status = 200) => {
      captured.status = status;
      captured.payload = data;
    },
    error: (_res, message, status = 500) => {
      captured.status = status;
      captured.payload = { error: message };
    },
  };

  const handled = await handleTrainingRoutes(ctx);
  expect(handled).toBe(true);
  return captured;
}

async function invokeCollectionRoute(
  body: Record<string, unknown>,
  service: TrainingServiceLike = trainingService(),
): Promise<{ status: number; payload: unknown }> {
  const captured: { status: number; payload: unknown } = {
    status: 200,
    payload: undefined,
  };
  const ctx: TrainingRouteContext = {
    req: {
      url: "/api/training/collect",
      headers: { host: "localhost" },
    } as http.IncomingMessage,
    res: {} as http.ServerResponse,
    method: "POST",
    pathname: "/api/training/collect",
    runtime: null,
    trainingService: service,
    isLoopbackHost: () => true,
    readJsonBody: async <T extends object>() => body as T,
    json: (_res, data, status = 200) => {
      captured.status = status;
      captured.payload = data;
    },
    error: (_res, message, status = 500) => {
      captured.status = status;
      captured.payload = { error: message };
    },
  };

  const handled = await handleTrainingRoutes(ctx);
  expect(handled).toBe(true);
  return captured;
}

describe("training routes", () => {
  afterEach(async () => {
    await Promise.all(
      tempDirs.splice(0).map((dir) =>
        rm(dir, {
          recursive: true,
          force: true,
        }),
      ),
    );
  });

  it("returns training collection preflight without running collection steps", async () => {
    const root = await makeTempDir();
    const workspaceRoot = join(root, "workspace");
    await mkdir(
      join(workspaceRoot, "packages", "app-core", "test", "benchmarks"),
      { recursive: true },
    );
    await writeFile(
      join(
        workspaceRoot,
        "packages",
        "app-core",
        "test",
        "benchmarks",
        "action-selection.real.test.ts",
      ),
      "",
      "utf8",
    );

    const result = await invokeCollectionRoute({
      preflightOnly: true,
      workspaceRoot,
      includeNaturalTrajectories: true,
      actionBenchmark: {
        dryRun: false,
        provider: "local-llama-cpp",
      },
      benchmarkVsCerebras: {
        dryRun: false,
      },
      includeBenchmarkVsCerebras: true,
    });

    expect(result.status).toBe(200);
    expect(result.payload).toMatchObject({
      preflight: {
        liveRequired: true,
        checks: expect.arrayContaining([
          expect.objectContaining({
            id: "app_core_action_benchmark",
            status: "ok",
          }),
          expect.objectContaining({
            id: "action_benchmark_provider",
            status: "warning",
          }),
        ]),
      },
    });
  });

  it("expands compact all-tier action benchmark pairs through the collection route", async () => {
    const root = await makeTempDir();
    const outputDir = join(root, "collection");

    const result = await invokeCollectionRoute({
      outputDir,
      includeHuggingFace: false,
      includeFeed: false,
      includeNaturalTrajectories: false,
      includeTestTrajectories: false,
      includeScenarios: false,
      includeEvalComparison: false,
      includeActionBenchmark: false,
      includeBenchmarkVsCerebras: false,
      includeEliza1ModelRegistry: false,
      includeEliza1BundleStage: false,
      includeBenchmarkMatrix: false,
      actionBenchmarkPairs: "all",
    });

    expect(result.status).toBe(201);
    expect(result.payload).toMatchObject({
      manifest: {
        recipe: {
          evals: {
            actionBenchmarkPairs: [
              expect.objectContaining({ tier: "2b" }),
              expect.objectContaining({ tier: "4b" }),
              expect.objectContaining({ tier: "9b" }),
              expect.objectContaining({ tier: "27b" }),
            ],
          },
        },
      },
    });
  });

  it("pulls app trajectories into natural trajectory collection runs", async () => {
    const root = await makeTempDir();
    const outputDir = join(root, "collection");
    const calls: Array<Record<string, unknown>> = [];
    const service = {
      ...trainingService(),
      listTrajectories: async (options: Record<string, unknown>) => {
        calls.push(options);
        return listResult(
          [trajRecord("traj-keep"), trajRecord("traj-drop")],
          2,
        );
      },
      getTrajectoryById: async (id: string) => {
        const runId = id === "traj-keep" ? "app-run-1" : "app-run-2";
        return {
          trajectoryId: id,
          agentId: "agent-1",
          roomId: "room-1",
          userId: "user-1",
          startTime: Date.now(),
          endTime: Date.now(),
          duration: 1,
          metadata: { runId },
          steps: [],
        };
      },
    } as TrainingServiceLike;

    const result = await invokeCollectionRoute(
      {
        outputDir,
        includeHuggingFace: false,
        includeFeed: false,
        includeNaturalTrajectories: true,
        includeTestTrajectories: false,
        includeScenarios: false,
        includeEvalComparison: false,
        includeActionBenchmark: false,
        includeBenchmarkVsCerebras: false,
        includeEliza1ModelRegistry: false,
        includeEliza1BundleStage: false,
        includeBenchmarkMatrix: false,
        naturalTrajectories: {
          runId: "app-run-1",
          limit: 2,
        },
      },
      service,
    );

    expect(calls).toEqual([
      {
        limit: 2,
        offset: 0,
        runId: "app-run-1",
      },
    ]);
    expect(result.status).toBe(201);
    const payload = result.payload as {
      manifest: {
        steps: Array<{
          id: string;
          status: string;
          result?: {
            manifest?: {
              runId?: string | null;
              source?: Record<string, unknown> & {
                metadata?: Record<string, unknown>;
              };
            };
          } | null;
        }>;
      };
    };
    expect(
      payload.manifest.steps.find((step) => step.id === "huggingface"),
    ).toMatchObject({ status: "skipped" });
    expect(
      payload.manifest.steps.find((step) => step.id === "feed"),
    ).toMatchObject({ status: "skipped" });
    expect(
      payload.manifest.steps.find((step) => step.id === "natural_trajectories"),
    ).toMatchObject({
      status: "succeeded",
      result: {
        manifest: {
          runId: "app-run-1",
          source: {
            kind: "training_collection_natural_trajectories",
            inputTrajectoryCount: 1,
            sanitizedTrajectoryCount: 1,
            metadata: {
              requestedLimit: 2,
              requestedRunId: "app-run-1",
              selectedTrajectoryIds: 2,
              loadedTrajectories: 2,
            },
          },
        },
      },
    });
  });

  it("preserves explicit mocked action benchmark requests", async () => {
    const root = await makeTempDir();
    const workspaceRoot = join(root, "workspace");
    const outputDir = join(root, "action-benchmark");
    const fakeBun = join(root, "fake-bun.sh");
    await mkdir(join(workspaceRoot, "packages", "app-core"), {
      recursive: true,
    });
    await writeFile(
      fakeBun,
      [
        "#!/bin/sh",
        'mkdir -p "$(dirname "$ELIZA_ACTION_BENCHMARK_REPORT_JSON_PATH")"',
        "cat > \"$ELIZA_ACTION_BENCHMARK_REPORT_JSON_PATH\" <<'JSON'",
        '{"schema":"eliza_action_selection_benchmark_report","summary":{"total":0,"passed":0,"failed":0},"results":[]}',
        "JSON",
        "printf '# Action benchmark\\n' > \"$ELIZA_ACTION_BENCHMARK_REPORT_PATH\"",
      ].join("\n"),
      "utf8",
    );
    await chmod(fakeBun, 0o755);

    const result = await invokeActionBenchmarkRoute({
      workspaceRoot,
      bun: fakeBun,
      outputDir,
      dryRun: false,
      useMocks: true,
      modelId: "eliza-1-2b-trained",
      variant: "trained",
      tier: "2b",
      benchmark: "eliza_harness_action_selection",
    });

    expect(result.status).toBe(201);
    expect(result.payload).toMatchObject({
      matrixSource: {
        modelId: "eliza-1-2b-trained",
        variant: "trained",
        useMocks: true,
      },
      env: {
        ELIZA_BENCHMARK_USE_MOCKS: "1",
      },
    });
  });
});
