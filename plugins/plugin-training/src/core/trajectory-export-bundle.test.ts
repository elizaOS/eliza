/**
 * Covers the privacy-filtered export bundle builder end to end on a temp
 * filesystem, asserting PII is stripped and per-task JSONL is emitted; the HTTP
 * upload path is stubbed (deterministic).
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import type http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Trajectory } from "@elizaos/agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleTrainingRoutes,
  type TrainingRouteContext,
} from "../routes/training-routes.js";
import type { TrainingServiceLike } from "../services/training-service-like.js";
import {
  buildTrajectoryExportBundle,
  TRAJECTORY_EXPORT_BUNDLE_SCHEMA,
  TRAJECTORY_EXPORT_BUNDLE_VERSION,
} from "./trajectory-export-bundle.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "trajectory-export-bundle-"));
  tempDirs.push(dir);
  return dir;
}

function baseTrajectory(): Trajectory {
  return {
    trajectoryId: "traj-1",
    agentId: "agent-1",
    startTime: 1_700_000_000_000,
    endTime: 1_700_000_001_000,
    durationMs: 1_000,
    steps: [
      {
        stepId: "step-1",
        timestamp: 1_700_000_000_100,
        llmCalls: [
          {
            callId: "call-1",
            purpose: "response",
            systemPrompt: "Reply directly.",
            userPrompt:
              "my key is sk-1234567890abcdef and coords are 37.7749, -122.4194",
            response: "I cannot help with exposed credentials.",
          },
        ],
      },
    ],
    metrics: { finalStatus: "completed" },
    metadata: { source: "test" },
  };
}

function withRunId(
  trajectory: Trajectory,
  trajectoryId: string,
  runId: string,
) {
  const firstStep = trajectory.steps?.[0];
  const firstCall = firstStep?.llmCalls?.[0];
  if (!firstStep || !firstCall) {
    throw new Error("baseTrajectory must include one LLM call");
  }
  return {
    ...trajectory,
    trajectoryId,
    steps: [
      {
        ...firstStep,
        llmCalls: [
          {
            ...firstCall,
            callId: `${trajectoryId}-call-1`,
            runId,
          },
        ],
      },
    ],
  };
}

function createTrainingService(
  overrides: Partial<TrainingServiceLike>,
): TrainingServiceLike {
  return {
    getStatus: vi.fn(() => ({})),
    listTrajectories: vi.fn(async () => ({
      trajectories: [],
      total: 0,
      offset: 0,
      limit: 100,
    })),
    getTrajectoryById: vi.fn(async () => null),
    listDatasets: vi.fn(() => []),
    buildDataset: vi.fn(async () => ({})),
    listJobs: vi.fn(() => []),
    startTrainingJob: vi.fn(async () => ({})),
    getJob: vi.fn(() => null),
    cancelJob: vi.fn(async () => ({})),
    listModels: vi.fn(() => []),
    importModelToOllama: vi.fn(async () => ({})),
    activateModel: vi.fn(async () => ({})),
    benchmarkModel: vi.fn(async () => ({})),
    ...overrides,
  };
}

async function invokeTrainingExportRoute(
  trainingService: TrainingServiceLike,
  body: Record<string, unknown>,
): Promise<{ status: number; payload: unknown }> {
  const captured: { status: number; payload: unknown } = {
    status: 200,
    payload: undefined,
  };
  const res = {} as http.ServerResponse;
  const ctx: TrainingRouteContext = {
    req: {
      url: "/api/training/trajectories/export",
      headers: { host: "localhost" },
    } as http.IncomingMessage,
    res,
    method: "POST",
    pathname: "/api/training/trajectories/export",
    runtime: null,
    trainingService,
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

async function invokeTrainingCollectRoute(
  trainingService: TrainingServiceLike,
  body: Record<string, unknown>,
): Promise<{ status: number; payload: unknown }> {
  const captured: { status: number; payload: unknown } = {
    status: 200,
    payload: undefined,
  };
  const res = {} as http.ServerResponse;
  const ctx: TrainingRouteContext = {
    req: {
      url: "/api/training/collect",
      headers: { host: "localhost" },
    } as http.IncomingMessage,
    res,
    method: "POST",
    pathname: "/api/training/collect",
    runtime: null,
    trainingService,
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

async function invokeTrainingCollectionsRoute(
  trainingService: TrainingServiceLike,
  query: URLSearchParams,
): Promise<{ status: number; payload: unknown }> {
  const captured: { status: number; payload: unknown } = {
    status: 200,
    payload: undefined,
  };
  const res = {} as http.ServerResponse;
  const ctx: TrainingRouteContext = {
    req: {
      url: `/api/training/collections?${query.toString()}`,
      headers: { host: "localhost" },
    } as http.IncomingMessage,
    res,
    method: "GET",
    pathname: "/api/training/collections",
    runtime: null,
    trainingService,
    isLoopbackHost: () => true,
    readJsonBody: async <T extends object>() => ({}) as T,
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

describe("trajectory export bundle", () => {
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      tempDirs
        .splice(0)
        .map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it("writes a sanitized bundle manifest without raw JSONL by default", async () => {
    const outputDir = await makeTempDir();

    const bundle = await buildTrajectoryExportBundle({
      outputDir,
      trajectories: [baseTrajectory()],
      tasks: ["response"],
      source: {
        kind: "test",
        metadata: { z: 1, a: 2 },
      },
      now: () => new Date("2026-01-02T03:04:05.000Z"),
    });

    expect(bundle.manifest).toMatchObject({
      schema: TRAJECTORY_EXPORT_BUNDLE_SCHEMA,
      schemaVersion: TRAJECTORY_EXPORT_BUNDLE_VERSION,
      generatedAt: "2026-01-02T03:04:05.000Z",
      runId: null,
      source: {
        kind: "test",
        runIds: [],
        inputTrajectoryCount: 1,
        sanitizedTrajectoryCount: 1,
        droppedTrajectoryCount: 0,
        metadata: { a: 2, z: 1 },
      },
      counts: {
        rawTrajectoryRows: 0,
        sanitizedTrajectoryRows: 1,
        taskRows: {
          should_respond: 0,
          context_routing: 0,
          action_planner: 0,
          response: 1,
          media_description: 0,
        },
        taskFiles: 1,
        taskExamples: 1,
      },
      cloudUpload: {
        uploadedToHuggingFace: false,
      },
    });
    expect(bundle.manifest.paths.rawJsonlPath).toBeUndefined();
    expect(bundle.manifest.paths.sanitizedJsonlPath).toBeTruthy();
    expect(bundle.manifest.paths.viewerHtmlPath).toBeTruthy();
    expect(bundle.manifest.privacy.applied).toBe(true);
    expect(bundle.manifest.privacy.redactionCount).toBeGreaterThanOrEqual(2);
    expect(bundle.manifest.tasks.response).toMatchObject({
      exampleCount: 1,
      sourceCallCount: 1,
      sourceTrajectoryCount: 1,
    });

    const manifestOnDisk = JSON.parse(
      await readFile(bundle.manifestPath, "utf8"),
    ) as typeof bundle.manifest;
    expect(manifestOnDisk.schema).toBe(TRAJECTORY_EXPORT_BUNDLE_SCHEMA);
    expect(manifestOnDisk.paths.rawJsonlPath).toBeUndefined();
    expect(manifestOnDisk.paths.viewerHtmlPath).toBe(
      bundle.manifest.paths.viewerHtmlPath,
    );

    const sanitized = await readFile(
      bundle.manifest.paths.sanitizedJsonlPath!,
      "utf8",
    );
    expect(sanitized).not.toContain("sk-1234567890abcdef");
    expect(sanitized).not.toContain("37.7749, -122.4194");
    expect(sanitized).toContain("<REDACTED:openai-key>");
    expect(sanitized).toContain("[REDACTED_GEO]");

    const viewer = await readFile(
      bundle.manifest.paths.viewerHtmlPath!,
      "utf8",
    );
    expect(viewer).toContain("Eliza Trajectory Export");
    expect(viewer).toContain("Task Datasets");
    expect(viewer).toContain("REDACTED:openai-key");
    expect(viewer).not.toContain("sk-1234567890abcdef");
  });

  it("writes raw JSONL only when explicitly requested", async () => {
    const outputDir = await makeTempDir();

    const bundle = await buildTrajectoryExportBundle({
      outputDir,
      trajectories: [baseTrajectory()],
      includeRawJsonl: true,
      tasks: ["response"],
    });

    expect(bundle.manifest.paths.rawJsonlPath).toBeTruthy();
    const raw = await readFile(bundle.manifest.paths.rawJsonlPath!, "utf8");
    const sanitized = await readFile(
      bundle.manifest.paths.sanitizedJsonlPath!,
      "utf8",
    );

    expect(raw).toContain("sk-1234567890abcdef");
    expect(sanitized).not.toContain("sk-1234567890abcdef");
    expect(bundle.manifest.counts.rawTrajectoryRows).toBe(1);
    const viewer = await readFile(
      bundle.manifest.paths.viewerHtmlPath!,
      "utf8",
    );
    expect(viewer).not.toContain("sk-1234567890abcdef");
  });

  it("builds route bundle exports with run lineage, raw opt-in, and task counts", async () => {
    const outputDir = await makeTempDir();
    const trajectories = new Map<string, Trajectory>([
      ["traj-1", withRunId(baseTrajectory(), "traj-1", "run-1")],
      ["traj-2", withRunId(baseTrajectory(), "traj-2", "run-2")],
    ]);
    const listTrajectories = vi.fn<TrainingServiceLike["listTrajectories"]>(
      async () => ({
        trajectories: [
          {
            id: "traj-1",
            agentId: "agent-1",
            source: "test",
            status: "completed",
            startTime: 1_700_000_000_000,
            endTime: 1_700_000_001_000,
            durationMs: 1_000,
            llmCallCount: 1,
            providerAccessCount: 0,
            totalPromptTokens: 0,
            totalCompletionTokens: 0,
            createdAt: "2026-01-02T03:04:05.000Z",
          },
          {
            id: "traj-2",
            agentId: "agent-1",
            source: "test",
            status: "completed",
            startTime: 1_700_000_000_000,
            endTime: 1_700_000_001_000,
            durationMs: 1_000,
            llmCallCount: 1,
            providerAccessCount: 0,
            totalPromptTokens: 0,
            totalCompletionTokens: 0,
            createdAt: "2026-01-02T03:04:05.000Z",
          },
        ],
        total: 2,
        offset: 0,
        limit: 100,
      }),
    );
    const getTrajectoryById = vi.fn<TrainingServiceLike["getTrajectoryById"]>(
      async (trajectoryId: string) => trajectories.get(trajectoryId) ?? null,
    );
    const trainingService = createTrainingService({
      listTrajectories,
      getTrajectoryById,
    });

    const response = await invokeTrainingExportRoute(trainingService, {
      exportBundle: true,
      includeRaw: true,
      runId: "run-1",
      outputDir,
      tasks: ["response"],
    });

    expect(response.status).toBe(201);
    expect(trainingService.listTrajectories).toHaveBeenCalledWith({
      limit: 100,
      offset: 0,
      runId: "run-1",
    });
    expect(trainingService.getTrajectoryById).toHaveBeenCalledTimes(2);

    const payload = response.payload as {
      trajectoriesConsidered: number;
      trajectoriesBundled: number;
      bundle: Awaited<
        ReturnType<typeof buildTrajectoryExportBundle>
      >["manifest"];
    };
    expect(payload.trajectoriesConsidered).toBe(2);
    expect(payload.trajectoriesBundled).toBe(1);
    expect(payload.bundle.runId).toBe("run-1");
    expect(payload.bundle.source).toMatchObject({
      kind: "training-trajectories-export-route",
      runId: "run-1",
      runIds: ["run-1"],
      inputTrajectoryCount: 1,
      sanitizedTrajectoryCount: 1,
      metadata: {
        requestedLimit: 100,
        requestedRunId: "run-1",
        selectedTrajectoryIds: 2,
        loadedTrajectories: 2,
        bundledTrajectories: 1,
      },
    });
    expect(payload.bundle.paths.rawJsonlPath).toBeTruthy();
    expect(payload.bundle.paths.sanitizedJsonlPath).toBeTruthy();
    expect(payload.bundle.paths.viewerHtmlPath).toBeTruthy();
    expect(payload.bundle.counts.taskRows.response).toBe(1);
    expect(payload.bundle.counts.taskExamples).toBe(1);
    expect(payload.bundle.privacy.applied).toBe(true);
    expect(payload.bundle.cloudUpload).toEqual({
      uploadedToHuggingFace: false,
    });

    const raw = await readFile(payload.bundle.paths.rawJsonlPath!, "utf8");
    expect(raw).toContain("sk-1234567890abcdef");
    const sanitized = await readFile(
      payload.bundle.paths.sanitizedJsonlPath!,
      "utf8",
    );
    expect(sanitized).not.toContain("sk-1234567890abcdef");
  });

  it("lets the training collection route pull natural runtime trajectories", async () => {
    const outputDir = await makeTempDir();
    const trajectory = withRunId(baseTrajectory(), "traj-natural-1", "run-1");
    const listTrajectories = vi.fn<TrainingServiceLike["listTrajectories"]>(
      async () => ({
        trajectories: [
          {
            id: "traj-natural-1",
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
          },
        ],
        total: 1,
        offset: 0,
        limit: 10,
      }),
    );
    const getTrajectoryById = vi.fn<TrainingServiceLike["getTrajectoryById"]>(
      async (trajectoryId: string) =>
        trajectoryId === "traj-natural-1" ? trajectory : null,
    );

    const response = await invokeTrainingCollectRoute(
      createTrainingService({
        listTrajectories,
        getTrajectoryById,
      }),
      {
        outputDir,
        includeHuggingFace: false,
        includeFeed: false,
        includeNaturalTrajectories: true,
        includeScenarios: false,
        includeEvalComparison: false,
        includeActionBenchmark: false,
        includeBenchmarkVsCerebras: false,
        includeEliza1ModelRegistry: false,
        includeEliza1BundleStage: false,
        includeBenchmarkMatrix: false,
        naturalTrajectories: {
          limit: 10,
          runId: "run-1",
          tasks: ["response"],
        },
      },
    );

    expect(response.status).toBe(201);
    expect(listTrajectories).toHaveBeenCalledWith({
      limit: 10,
      offset: 0,
      runId: "run-1",
    });
    expect(getTrajectoryById).toHaveBeenCalledWith("traj-natural-1");
    const payload = response.payload as {
      readmePath: string;
      manifest: {
        readmePath: string;
        steps: Array<{ id: string; status: string }>;
        evidence: {
          sourceSamples: {
            natural: Array<{
              trajectoryId: string | null;
              input: unknown;
              output: unknown;
            }>;
          };
        };
      };
      analysis: { manifest: { counts: Record<string, number> } };
    };
    expect(payload.readmePath).toBe(join(outputDir, "README.md"));
    expect(payload.manifest.readmePath).toBe(payload.readmePath);
    expect(payload.manifest.steps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "natural_trajectories",
          status: "succeeded",
        }),
        expect.objectContaining({
          id: "eliza1_model_registry",
          status: "skipped",
        }),
      ]),
    );
    expect(payload.analysis.manifest.counts.trajectoryBundles).toBe(1);
    expect(payload.analysis.manifest.counts.trajectoryDatasets).toBe(2);
    expect(payload.manifest.evidence.sourceSamples.natural).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          trajectoryId: "traj-natural-1",
        }),
      ]),
    );
    const readme = await readFile(payload.readmePath, "utf8");
    expect(readme).toContain("# Eliza Training Collection");
    expect(readme).toContain("analysis/index.html");
    expect(readme).toContain("Natural");

    const listResponse = await invokeTrainingCollectionsRoute(
      createTrainingService({}),
      new URLSearchParams({ root: outputDir, limit: "5" }),
    );
    expect(listResponse.status).toBe(200);
    expect(listResponse.payload).toMatchObject({
      root: outputDir,
      collections: [
        {
          outputDir,
          manifestPath: join(outputDir, "collection-manifest.json"),
          readmePath: join(outputDir, "README.md"),
          analysisIndexHtmlPath: join(outputDir, "analysis", "index.html"),
          readinessStatus: expect.any(String),
          dataSources: {
            naturalTrajectoryBundles: 1,
          },
        },
      ],
    });
  });
});
