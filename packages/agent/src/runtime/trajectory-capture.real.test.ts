/**
 * End-to-end trajectory capture verification.
 *
 * Reproduces and guards the dual-writer failure where the agent bridge and core
 * service both handled one capture despite owning incompatible step/reward
 * shapes. The installed bridge owns lifecycle, writes, and reads together;
 * this suite proves its real PGlite row and HTTP read boundary stay coherent.
 *
 * The test drives the exact provider/LLM capture primitives used by the runtime,
 * drains every queue, reads the active and completed metrics from SQL, exercises
 * the real viewer read routes, and checks a clean idle diagnostic tail.
 */

import fs from "node:fs";
import type { ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import {
  AgentRuntime,
  type Plugin,
  tryHandleTrajectoryReadRoutes,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  asRecord,
  executeRawSql,
  extractRows,
  parseMetadata,
} from "./trajectory-internals.ts";
import { installDatabaseTrajectoryLogger } from "./trajectory-persistence.ts";
import { flushTrajectoryWrites } from "./trajectory-storage.ts";

interface CapturedLlmCall {
  provider?: string;
  model?: string;
}
interface TrajectoryDetailLike {
  steps?: Array<{
    llmCalls?: CapturedLlmCall[];
    providerAccesses?: Array<{ providerName?: string }>;
    action?: unknown;
  }>;
  metrics?: { episodeLength?: number; finalStatus?: string };
}
interface TrajLogger {
  startTrajectory: (
    agentId: string,
    opts?: { source?: string; metadata?: Record<string, unknown> },
  ) => Promise<string>;
  startStep: (trajectoryId: string) => string;
  logLlmCall: (params: Record<string, unknown>) => void;
  logProviderAccess: (params: Record<string, unknown>) => void;
  endTrajectory: (trajectoryId: string, status?: string) => Promise<void>;
  flushWriteQueue?: (trajectoryId: string) => Promise<void>;
  listTrajectories: (opts?: { limit?: number; offset?: number }) => Promise<{
    trajectories: Array<{ id: string; llmCallCount: number }>;
    total: number;
  }>;
  getTrajectoryDetail: (id: string) => Promise<TrajectoryDetailLike | null>;
}

async function readRoute(pathname: string): Promise<{
  status: number;
  body: unknown;
}> {
  const state = { status: 0, body: undefined as unknown };
  const response = {
    statusCode: 0,
    setHeader() {},
    end(payload?: string) {
      state.status = response.statusCode;
      state.body = payload ? JSON.parse(payload) : undefined;
    },
  } as unknown as ServerResponse;
  const handled = await tryHandleTrajectoryReadRoutes({
    pathname,
    method: "GET",
    url: new URL(`http://localhost${pathname}`),
    runtime,
    res: response,
  });
  expect(handled).toBe(true);
  return state;
}

async function readMetrics(
  trajectoryId: string,
): Promise<Record<string, unknown>> {
  const result = await executeRawSql(
    runtime,
    `SELECT metrics_json FROM trajectories WHERE id = '${trajectoryId.replaceAll("'", "''")}'`,
  );
  const row = asRecord(extractRows(result)[0]);
  return parseMetadata(row?.metrics_json);
}

function llmCall(
  stepId: string,
  provider: string,
  model: string,
  text: string,
) {
  return {
    stepId,
    model,
    modelType: "TEXT_LARGE",
    provider,
    systemPrompt: "You are a test agent.",
    userPrompt: "Say hello.",
    prompt: "Say hello.",
    response: text,
    temperature: 0,
    maxTokens: 64,
    purpose: "action",
    actionType: "runtime.useModel",
    latencyMs: 12,
    promptTokens: 8,
    completionTokens: 4,
  };
}

let runtime: AgentRuntime;
let pgliteDir: string;
const prevPgliteDir = process.env.PGLITE_DATA_DIR;

beforeAll(async () => {
  // Mirror @elizaos/core/testing createTestRuntime inline (the testing subpath
  // is not aliased in the agent's vitest config). Real PGLite-backed runtime;
  // trajectories load by default (enableTrajectories defaults on).
  pgliteDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-traj-e2e-"));
  process.env.PGLITE_DATA_DIR = pgliteDir;

  runtime = new AgentRuntime({
    character: { name: "TrajCapture" },
    plugins: [],
    logLevel: "warn",
    enableAutonomy: false,
  });

  const pluginSqlModule = (await import(
    ["@elizaos", "plugin-sql"].join("/")
  )) as { default?: Plugin; elizaPlugin?: Plugin };
  const pluginSql = pluginSqlModule.default ?? pluginSqlModule.elizaPlugin;
  if (!pluginSql) throw new Error("plugin-sql did not export a plugin");
  await runtime.registerPlugin(pluginSql);
  await runtime.initialize();

  // The "trajectories" native-feature service (enabled by default) starts
  // asynchronously after DB init — the real boot waits via
  // waitForTrajectoriesService before installing the bridge.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline && !runtime.getService("trajectories")) {
    await new Promise((r) => setTimeout(r, 50));
  }

  // The boot wiring under test (prepareRuntimeForTrajectoryCapture installs this).
  await installDatabaseTrajectoryLogger(runtime);
}, 180_000);

afterAll(async () => {
  try {
    await runtime?.stop();
  } catch {
    // ignore
  }
  if (prevPgliteDir === undefined) {
    delete process.env.PGLITE_DATA_DIR;
  } else {
    process.env.PGLITE_DATA_DIR = prevPgliteDir;
  }
  if (pgliteDir) {
    try {
      fs.rmSync(pgliteDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
});

describe("trajectory capture -> DB -> viewer", () => {
  it("persists provider/LLM appends with valid active and completed metrics", async () => {
    const logger = runtime.getService(
      "trajectories",
    ) as unknown as TrajLogger | null;
    expect(logger).toBeTruthy();
    if (!logger) return;

    const trajectoryId = await logger.startTrajectory(runtime.agentId, {
      source: "test",
      metadata: { roomId: "room-traj-test" },
    });
    expect(typeof trajectoryId).toBe("string");
    expect(trajectoryId.length).toBeGreaterThan(0);

    const stepId = logger.startStep(trajectoryId);
    const reportError = vi.spyOn(runtime, "reportError");

    logger.logProviderAccess({
      stepId,
      providerName: "facts",
      purpose: "context",
      data: { count: 1 },
    });

    // The exact capture primitive runtime.recordUseModelTrajectory invokes,
    // for a local-inference provider AND a cloud provider.
    logger.logLlmCall(
      llmCall(stepId, "local-inference", "eliza-1-2b", "hello from local"),
    );
    logger.logLlmCall(llmCall(stepId, "openai", "gpt-5.5", "hello from cloud"));

    // Flush the async step-write queue the bridge enqueues.
    await flushTrajectoryWrites(runtime);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await logger.flushWriteQueue?.(trajectoryId);

    expect(await readMetrics(trajectoryId)).toMatchObject({
      episodeLength: 1,
      finalStatus: "active",
    });
    const activeDetail = await logger.getTrajectoryDetail(trajectoryId);
    expect(activeDetail?.metrics?.finalStatus).toBe("active");
    const activeProviders = (activeDetail?.steps ?? []).flatMap(
      (step) => step.providerAccesses ?? [],
    );
    expect(activeProviders).toContainEqual(
      expect.objectContaining({ providerName: "facts" }),
    );

    await logger.endTrajectory(trajectoryId, "completed");
    await flushTrajectoryWrites(runtime);
    await new Promise<void>((resolve) => setImmediate(resolve));
    await logger.flushWriteQueue?.(trajectoryId);
    expect(await readMetrics(trajectoryId)).toMatchObject({
      episodeLength: 1,
      finalStatus: "completed",
    });

    // Read back via the SAME SQL read API the viewer + collection use.
    const list = await logger.listTrajectories({ limit: 50, offset: 0 });
    expect(list.total).toBeGreaterThan(0);
    const found = list.trajectories.find((t) => t.id === trajectoryId);
    expect(
      found,
      "trajectory must be listed by the viewer reader",
    ).toBeTruthy();
    expect(
      found?.llmCallCount ?? 0,
      "BOTH local + cloud LLM calls must be counted",
    ).toBeGreaterThanOrEqual(2);

    const detail = await logger.getTrajectoryDetail(trajectoryId);
    expect(detail?.metrics?.finalStatus).toBe("completed");
    expect(detail?.metrics?.episodeLength).toBeGreaterThanOrEqual(1);
    const calls = (detail?.steps ?? []).flatMap((s) => s.llmCalls ?? []);
    const providers = new Set(
      calls.map((c) => c.provider).filter((p): p is string => Boolean(p)),
    );
    expect(providers.has("local-inference"), "local call persisted").toBe(true);
    expect(providers.has("openai"), "cloud call persisted").toBe(true);
    expect((detail?.steps ?? []).every((step) => step.action == null)).toBe(true);

    const listRoute = await readRoute("/api/trajectories");
    expect(listRoute.status).toBe(200);
    const listBody = asRecord(listRoute.body);
    expect(listBody?.trajectories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: trajectoryId, llmCallCount: 2 }),
      ]),
    );

    const detailRoute = await readRoute(`/api/trajectories/${trajectoryId}`);
    expect(detailRoute.status).toBe(200);
    const detailBody = asRecord(detailRoute.body);
    expect(detailBody?.toolEvents).toEqual([]);
    expect(detailBody?.llmCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: "local-inference" }),
        expect.objectContaining({ provider: "openai" }),
      ]),
    );
    expect(detailBody?.providerAccesses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ providerName: "facts" }),
      ]),
    );

    await new Promise((resolve) => setTimeout(resolve, 100));
    await flushTrajectoryWrites(runtime);
    await logger.flushWriteQueue?.(trajectoryId);
    const detachedFailures = reportError.mock.calls.filter(
      ([scope, error]) =>
        scope === "TrajectoriesService.detachedWrite" ||
        (error instanceof Error &&
          error.message.includes("TRAJECTORY_ROW_INVALID")),
    );
    expect(detachedFailures).toEqual([]);
  });
});
