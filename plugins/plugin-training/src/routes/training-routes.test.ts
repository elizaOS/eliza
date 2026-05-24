import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { TrainingServiceLike } from "../services/training-service-like.js";
import {
  handleTrainingRoutes,
  type TrainingRouteContext,
} from "./training-routes.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "training-routes-"));
  tempDirs.push(dir);
  return dir;
}

function trainingService(): TrainingServiceLike {
  return {
    getStatus: () => ({}),
    listTrajectories: async () => ({ trajectories: [], total: 0 }),
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
      join(
        workspaceRoot,
        "packages",
        "app-core",
        "test",
        "benchmarks",
      ),
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
        "mkdir -p \"$(dirname \"$ELIZA_ACTION_BENCHMARK_REPORT_JSON_PATH\")\"",
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
      modelId: "eliza-1-0_8b-trained",
      variant: "trained",
      tier: "0_8b",
      benchmark: "eliza_harness_action_selection",
    });

    expect(result.status).toBe(201);
    expect(result.payload).toMatchObject({
      matrixSource: {
        modelId: "eliza-1-0_8b-trained",
        variant: "trained",
        useMocks: true,
      },
      env: {
        ELIZA_BENCHMARK_USE_MOCKS: "1",
      },
    });
  });
});
