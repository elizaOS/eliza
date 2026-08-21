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
  type Action,
  AgentRuntime,
  ChannelType,
  DefaultMessageService,
  drainPostDeliveryTasks,
  executePlannedToolCall,
  getTrajectoryContext,
  type Memory,
  ModelType,
  type Plugin,
  type Provider,
  runWithTrajectoryContext,
  trajectoriesPlugin,
  tryHandleTrajectoryReadRoutes,
  type UUID,
  withEvaluatorStep,
} from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  asRecord,
  createBaseTrajectory,
  ensureTrajectoriesTable,
  executeRawSql,
  extractRows,
  loadTrajectoryById,
  loadTrajectoryByStepId,
  parseMetadata,
  saveTrajectory,
} from "./trajectory-internals.ts";
import { installDatabaseTrajectoryLogger } from "./trajectory-persistence.ts";
import { loadPersistedTrajectoryRows } from "./trajectory-query.ts";
import { getSteps } from "./trajectory-steps-reader.ts";
import {
  clearAllSteps,
  deleteStepsForTrajectories,
  upsertStep,
} from "./trajectory-steps-writer.ts";
import {
  __getTrajectoryBridgeStateCountsForTests,
  DatabaseTrajectoryLogger,
  flushTrajectoryWrites,
} from "./trajectory-storage.ts";

interface CapturedLlmCall {
  provider?: string;
  model?: string;
  purpose?: string;
}
interface TrajectoryDetailLike {
  steps?: Array<{
    stepId?: string;
    parentStepId?: string;
    childSteps?: string[];
    evaluatorName?: string;
    kind?: string;
    llmCalls?: CapturedLlmCall[];
    providerAccesses?: Array<{
      providerId?: string;
      providerName?: string;
      timestamp?: number;
      purpose?: string;
      data?: Record<string, unknown>;
    }>;
    action?: {
      actionName?: string;
      success?: boolean;
      result?: Record<string, unknown>;
    };
  }>;
  metrics?: { episodeLength?: number; finalStatus?: string };
}
interface TrajLogger {
  setEnabled?: (enabled: boolean) => void;
  startTrajectory: (
    agentId: string,
    opts?: {
      agentId?: string;
      source?: string;
      metadata?: Record<string, unknown>;
    },
  ) => Promise<string>;
  startStep: (trajectoryId: string) => string;
  getCurrentStepId?: (trajectoryId: string) => string | null;
  logLlmCall: (params: Record<string, unknown>) => void;
  logProviderAccess: (params: Record<string, unknown>) => void;
  endTrajectory: (trajectoryId: string, status?: string) => Promise<void>;
  flushWriteQueue?: (trajectoryId: string) => Promise<void>;
  listTrajectories: (opts?: { limit?: number; offset?: number }) => Promise<{
    trajectories: Array<{ id: string; llmCallCount: number }>;
    total: number;
  }>;
  getTrajectoryDetail: (id: string) => Promise<TrajectoryDetailLike | null>;
  deleteTrajectories: (ids: string[]) => Promise<number>;
  exportTrajectories: (options: {
    format: "jsonl" | "json";
    trajectoryIds?: string[];
  }) => Promise<{ data: string }>;
}

type LifecycleTrajLogger = TrajLogger & {
  releaseTrajectoryOwnership: (stepIdOrTrajectoryId: string) => void;
  stop: () => Promise<void>;
};

type TrajectoryEventHandler = (
  payload: Record<string, unknown>,
) => Promise<void>;

function trajectoryEventHandler(
  event: "MESSAGE_RECEIVED" | "RUN_STARTED" | "MESSAGE_SENT" | "RUN_ENDED",
): TrajectoryEventHandler {
  const handlers = (
    trajectoriesPlugin.events as Record<string, TrajectoryEventHandler[]>
  )[event];
  const handler = handlers?.[0];
  if (!handler) throw new Error(`Missing trajectories ${event} handler`);
  return handler;
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

function directResponseEnvelope(replyText: string) {
  return {
    text: "",
    toolCalls: [
      {
        id: "terminal-owner-response",
        name: "HANDLE_RESPONSE",
        arguments: {
          shouldRespond: "RESPOND",
          thought: "Direct answer.",
          contexts: ["simple"],
          intents: [],
          candidateActionNames: [],
          replyText,
          facts: [],
          relationships: [],
          addressedTo: [],
        },
      },
    ],
    finishReason: "tool_calls",
  };
}

function recordLoggerCapture(
  logger: LifecycleTrajLogger,
  captureType: "llm" | "provider",
  stepId: string,
  label: string,
): void {
  if (captureType === "llm") {
    logger.logLlmCall(llmCall(stepId, "openai", label, `capture ${label}`));
    return;
  }
  logger.logProviderAccess({
    stepId,
    providerName: label,
    purpose: "context",
    data: { label },
  });
}

function sqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const chunks = (value as { queryChunks?: Array<{ value?: unknown }> })
    .queryChunks;
  if (!Array.isArray(chunks)) return String(value);
  return chunks
    .flatMap((chunk) => (Array.isArray(chunk.value) ? chunk.value : []))
    .join("");
}

function sharedDatabaseRuntime(agentId: string): AgentRuntime {
  const source = runtime as unknown as Record<string, unknown>;
  return {
    agentId,
    adapter: source.adapter,
    actions: [],
    getRoom: async () => null,
    getService: () => null,
    getServicesByType: () => [],
    reportError: vi.fn(),
    logger: runtime.logger,
  } as unknown as AgentRuntime;
}

type TestSqlExecutor = {
  execute: (query: unknown) => Promise<unknown>;
};

type TestRuntimeDb = TestSqlExecutor & {
  transaction: <T>(callback: (tx: TestSqlExecutor) => Promise<T>) => Promise<T>;
};

function transactionGatedRuntime(agentId: string): {
  runtime: AgentRuntime;
  gate: {
    arm: () => void;
    entered: Promise<void>;
    release: () => void;
  };
} {
  const gatedRuntime = sharedDatabaseRuntime(agentId);
  const baseDb = (gatedRuntime as unknown as { adapter: { db: TestRuntimeDb } })
    .adapter.db;
  let armed = false;
  let used = false;
  let markEntered: () => void = () => {};
  let releaseTransaction: () => void = () => {};
  const entered = new Promise<void>((resolve) => {
    markEntered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseTransaction = resolve;
  });
  const gatedDb: TestRuntimeDb = {
    execute: baseDb.execute.bind(baseDb),
    transaction: async <T>(
      callback: (tx: TestSqlExecutor) => Promise<T>,
    ): Promise<T> => {
      if (armed && !used) {
        used = true;
        markEntered();
        await released;
      }
      return baseDb.transaction(callback);
    },
  };
  (gatedRuntime as unknown as { adapter: { db: TestRuntimeDb } }).adapter = {
    db: gatedDb,
  };
  return {
    runtime: gatedRuntime,
    gate: {
      arm: () => {
        armed = true;
      },
      entered,
      release: releaseTransaction,
    },
  };
}

async function installedDatabaseLogger(
  agentId: string,
  installedRuntime = sharedDatabaseRuntime(agentId),
): Promise<{
  runtime: AgentRuntime;
  logger: LifecycleTrajLogger;
}> {
  let enabled = true;
  const candidate = {
    isEnabled: () => enabled,
    setEnabled: (next: boolean) => {
      enabled = next;
    },
    logLlmCall: () => {},
    logProviderAccess: () => {},
    stop: async () => {},
  };
  Object.assign(installedRuntime as unknown as Record<string, unknown>, {
    getService: () => candidate,
    getServicesByType: () => [candidate],
  });
  await installDatabaseTrajectoryLogger(installedRuntime);
  const installed = candidate as unknown as LifecycleTrajLogger;
  installed.setEnabled?.(true);
  return { runtime: installedRuntime, logger: installed };
}

async function databaseLogger(
  mode: "public" | "installed",
  agentId: string,
  loggerRuntime = sharedDatabaseRuntime(agentId),
): Promise<{ runtime: AgentRuntime; logger: LifecycleTrajLogger }> {
  if (mode === "installed") {
    return installedDatabaseLogger(agentId, loggerRuntime);
  }
  await ensureTrajectoriesTable(loggerRuntime);
  const logger = new DatabaseTrajectoryLogger(
    loggerRuntime,
  ) as LifecycleTrajLogger;
  logger.setEnabled?.(true);
  return { runtime: loggerRuntime, logger };
}

let runtime: AgentRuntime;
let pgliteDir: string;
const prevPgliteDir = process.env.PGLITE_DATA_DIR;

const viewsAction: Action = {
  name: "VIEWS",
  description: "Open a named test view after model-assisted resolution.",
  contexts: ["general"],
  parameters: [
    {
      name: "view",
      description: "View to open.",
      required: true,
      schema: { type: "string" },
    },
  ],
  validate: async () => true,
  handler: async (actionRuntime, _message, _state, options) => {
    const resolution = await actionRuntime.useModel(ModelType.TEXT_SMALL, {
      prompt: "Resolve the requested calendar view.",
    });
    const parameters = asRecord(options?.parameters);
    if (typeof parameters?.view !== "string") {
      throw new Error("VIEWS fixture requires a string view parameter");
    }
    const view = parameters.view;
    return {
      success: true,
      text: `Opened ${view}.`,
      data: { actionName: "VIEWS", view, resolution },
    };
  },
};

const trajectoryActionPlugin: Plugin = {
  name: "trajectory-action-round-trip",
  description: "Deterministic nested-model action for trajectory persistence.",
  actions: [viewsAction],
  models: {
    [ModelType.TEXT_SMALL]: async () => "calendar",
  },
};

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
  await runtime.registerPlugin(trajectoryActionPlugin);
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
  (
    runtime.getService("trajectories") as unknown as TrajLogger | null
  )?.setEnabled?.(true);
}, 180_000);

afterAll(async () => {
  try {
    await runtime?.stop();
  } catch (error) {
    // error-policy:J6 test teardown must continue to restore the environment.
    void error;
  }
  if (prevPgliteDir === undefined) {
    delete process.env.PGLITE_DATA_DIR;
  } else {
    process.env.PGLITE_DATA_DIR = prevPgliteDir;
  }
  if (pgliteDir) {
    try {
      fs.rmSync(pgliteDir, { recursive: true, force: true });
    } catch (error) {
      // error-policy:J6 temporary PGlite cleanup is best-effort at suite exit.
      void error;
    }
  }
});

describe("trajectory capture -> DB -> viewer", () => {
  it("retains required provider fields after bounded SQL persistence", async () => {
    const logger = runtime.getService(
      "trajectories",
    ) as unknown as TrajLogger | null;
    expect(logger).toBeTruthy();
    if (!logger) return;

    const trajectoryId = await logger.startTrajectory(runtime.agentId, {
      source: "provider-budget-test",
    });
    const stepId = logger.startStep(trajectoryId);
    const data = Object.fromEntries(
      Array.from({ length: 20 }, (_, index) => [
        `chunk-${index}`,
        "x".repeat(70_000),
      ]),
    );

    logger.logProviderAccess({
      stepId,
      providerName: "KNOWLEDGE",
      purpose: "Provider KNOWLEDGE accessed for context",
      data,
    });
    await flushTrajectoryWrites(runtime);
    await logger.flushWriteQueue?.(trajectoryId);

    const row = asRecord(
      extractRows(
        await executeRawSql(
          runtime,
          `SELECT payload FROM trajectory_steps WHERE id = '${stepId.replaceAll("'", "''")}'`,
        ),
      )[0],
    );
    const payload = parseMetadata(row?.payload);
    const persistedAccess = Array.isArray(payload.providerAccesses)
      ? asRecord(payload.providerAccesses[0])
      : null;
    expect(persistedAccess).toMatchObject({
      providerName: "KNOWLEDGE",
      purpose: "Provider KNOWLEDGE accessed for context",
    });
    expect(persistedAccess?.providerId).toBeTypeOf("string");
    expect(persistedAccess?.timestamp).toBeTypeOf("number");
    expect(persistedAccess?.data).toBeTypeOf("object");

    const detail = await logger.getTrajectoryDetail(trajectoryId);
    const readback = detail?.steps?.find((step) => step.stepId === stepId)
      ?.providerAccesses?.[0];
    expect(readback).toMatchObject({
      providerName: "KNOWLEDGE",
      purpose: "Provider KNOWLEDGE accessed for context",
    });
    expect(readback?.providerId).toBeTypeOf("string");
    expect(readback?.timestamp).toBeTypeOf("number");
    expect(readback?.data).toBeTypeOf("object");

    await logger.endTrajectory(trajectoryId, "completed");
    await flushTrajectoryWrites(runtime);
    await logger.flushWriteQueue?.(trajectoryId);
  });

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
    expect((detail?.steps ?? []).every((step) => step.action == null)).toBe(
      true,
    );

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

  it("keeps one successful VIEWS action and its nested model call on the completed parent", async () => {
    const logger = runtime.getService(
      "trajectories",
    ) as unknown as TrajLogger | null;
    expect(logger).toBeTruthy();
    if (!logger) return;

    const reportError = vi.spyOn(runtime, "reportError");
    const trajectoryId = await logger.startTrajectory(runtime.agentId, {
      source: "test",
      metadata: { roomId: "room-views-trajectory" },
    });
    const parentStepId = logger.startStep(trajectoryId);
    await logger.flushWriteQueue?.(trajectoryId);

    const message = {
      id: crypto.randomUUID(),
      agentId: runtime.agentId,
      entityId: runtime.agentId,
      roomId: crypto.randomUUID(),
      createdAt: Date.now(),
      content: { text: "Open my calendar", source: "chat" },
      metadata: { trajectoryId, trajectoryStepId: parentStepId },
    } as Memory;

    const result = await runWithTrajectoryContext(
      { trajectoryId, trajectoryStepId: parentStepId, purpose: "planner" },
      () =>
        executePlannedToolCall(
          runtime,
          { message, activeContexts: ["general"] },
          { name: "VIEWS", params: { view: "calendar" } },
        ),
    );
    expect(result, JSON.stringify(result)).toMatchObject({
      success: true,
      data: { actionName: "VIEWS", view: "calendar", resolution: "calendar" },
    });
    expect(__getTrajectoryBridgeStateCountsForTests(runtime)).toEqual({
      stepMappings: 3,
      activeOwners: 1,
    });

    const terminalization = logger.endTrajectory(trajectoryId, "completed");
    logger.logProviderAccess({
      stepId: parentStepId,
      providerName: "delivery-receipt",
      purpose: "post-delivery",
      data: { delivered: true },
    });
    await terminalization;
    expect(__getTrajectoryBridgeStateCountsForTests(runtime)).toEqual({
      stepMappings: 0,
      activeOwners: 0,
    });
    await flushTrajectoryWrites(runtime, trajectoryId);
    await logger.flushWriteQueue?.(trajectoryId);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const stepRowsResult = await executeRawSql(
      runtime,
      `SELECT id, parent_step_id, payload
       FROM trajectory_steps
       WHERE trajectory_id = '${trajectoryId.replaceAll("'", "''")}'
       ORDER BY ordinal ASC`,
    );
    const stepRows = extractRows(stepRowsResult).map(asRecord);
    const persistedActionStep = stepRows.find((row) => {
      const payload = parseMetadata(row?.payload);
      return asRecord(payload.action)?.actionName === "VIEWS";
    });
    expect(persistedActionStep, JSON.stringify(stepRows)).toMatchObject({
      parent_step_id: parentStepId,
    });

    const detail = await logger.getTrajectoryDetail(trajectoryId);
    expect(detail?.metrics?.finalStatus).toBe("completed");
    const actionSteps = (detail?.steps ?? []).filter(
      (step) => step.action?.actionName === "VIEWS",
    );
    expect(actionSteps).toHaveLength(1);
    expect(actionSteps[0]).toMatchObject({
      parentStepId,
      action: {
        actionName: "VIEWS",
        success: true,
        result: {
          success: true,
          data: { actionName: "VIEWS", view: "calendar" },
        },
      },
    });
    expect(actionSteps[0]?.llmCalls).toEqual([
      expect.objectContaining({ purpose: "action" }),
    ]);
    expect(
      (detail?.steps ?? []).find((step) => step.stepId === parentStepId)
        ?.providerAccesses,
    ).toEqual([]);
    expect(reportError.mock.calls).toEqual(
      expect.arrayContaining([
        [
          "TrajectoryStorage.lateCapture",
          expect.objectContaining({ code: "TRAJECTORY_OWNER_CLOSED" }),
          expect.objectContaining({
            stepId: parentStepId,
            captureType: "provider",
            diagnosticOnly: true,
          }),
        ],
      ]),
    );

    const rowResult = await executeRawSql(
      runtime,
      `SELECT id, status, start_time, end_time, duration_ms
       FROM trajectories
       WHERE id = '${trajectoryId.replaceAll("'", "''")}'`,
    );
    const row = asRecord(extractRows(rowResult)[0]);
    expect(row?.status).toBe("completed");
    expect(Number.isFinite(Number(row?.end_time))).toBe(true);
    expect(Number.isFinite(Number(row?.duration_ms))).toBe(true);
    expect(Number(row?.end_time)).toBeGreaterThanOrEqual(
      Number(row?.start_time),
    );
    expect(Number(row?.duration_ms)).toBeGreaterThanOrEqual(0);

    const orphanResult = await executeRawSql(
      runtime,
      "SELECT id FROM trajectories WHERE id LIKE 'action-%' AND status = 'active'",
    );
    expect(extractRows(orphanResult)).toEqual([]);

    const listRoute = await readRoute("/api/trajectories");
    expect(listRoute.status).toBe(200);
    const listBody = asRecord(listRoute.body);
    expect(listBody?.trajectories).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: trajectoryId })]),
    );

    const detailRoute = await readRoute(`/api/trajectories/${trajectoryId}`);
    expect(detailRoute.status).toBe(200);
    const detailBody = asRecord(detailRoute.body);
    expect(detailBody?.toolEvents).toEqual([
      expect.objectContaining({
        actionName: "VIEWS",
        status: "completed",
        success: true,
      }),
    ]);
    expect(detailBody?.llmCalls).toHaveLength(1);

    await new Promise((resolve) => setTimeout(resolve, 100));
    await flushTrajectoryWrites(runtime, trajectoryId);
    await logger.flushWriteQueue?.(trajectoryId);
    const idleRows = await executeRawSql(
      runtime,
      "SELECT id FROM trajectories WHERE status = 'active' AND id LIKE 'action-%'",
    );
    expect(extractRows(idleRows)).toEqual([]);
    expect(
      reportError.mock.calls.filter(
        ([scope]) =>
          scope === "TrajectoriesService.detachedWrite" ||
          scope === "TrajectoryActionStep.complete" ||
          scope === "TrajectoryActionStep.normalize",
      ),
    ).toEqual([]);
  });

  it("persists RUN_ENDED errors as terminated and renders them as errors", async () => {
    const message = {
      id: crypto.randomUUID(),
      agentId: runtime.agentId,
      entityId: runtime.agentId,
      roomId: crypto.randomUUID(),
      createdAt: Date.now(),
      content: { text: "Fail this run", source: "chat" },
    } as Memory;

    await trajectoryEventHandler("MESSAGE_RECEIVED")({
      runtime,
      message,
      source: "test",
    });
    const metadata = asRecord(message.metadata);
    const trajectoryId = metadata?.trajectoryId;
    expect(typeof trajectoryId).toBe("string");
    if (typeof trajectoryId !== "string") return;

    await trajectoryEventHandler("RUN_ENDED")({
      runtime,
      messageId: message.id,
      status: "error",
    });
    await flushTrajectoryWrites(runtime, trajectoryId);

    const rowResult = await executeRawSql(
      runtime,
      `SELECT status, metrics_json FROM trajectories
       WHERE id = '${trajectoryId.replaceAll("'", "''")}'`,
    );
    const row = asRecord(extractRows(rowResult)[0]);
    expect(row?.status).toBe("terminated");
    expect(parseMetadata(row?.metrics_json).finalStatus).toBe("terminated");

    const listRoute = await readRoute("/api/trajectories");
    expect(listRoute.status).toBe(200);
    const listBody = asRecord(listRoute.body);
    const trajectories = Array.isArray(listBody?.trajectories)
      ? listBody.trajectories
      : [];
    expect(trajectories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: trajectoryId, status: "error" }),
      ]),
    );

    const detailRoute = await readRoute(`/api/trajectories/${trajectoryId}`);
    expect(detailRoute.status).toBe(200);
    expect(asRecord(asRecord(detailRoute.body)?.trajectory)?.status).toBe(
      "error",
    );
    expect(__getTrajectoryBridgeStateCountsForTests(runtime)).toEqual({
      stepMappings: 0,
      activeOwners: 0,
    });
  });

  it("persists evaluator ownership through the real child-step bridge", async () => {
    const logger = runtime.getService("trajectories") as unknown as TrajLogger;
    const trajectoryId = await logger.startTrajectory(runtime.agentId, {
      source: "evaluator-test",
    });
    const parentStepId = logger.startStep(trajectoryId);

    await runWithTrajectoryContext(
      { trajectoryId, trajectoryStepId: parentStepId },
      () =>
        withEvaluatorStep(runtime, "real-quality-gate", async () => {
          const evaluatorStepId = logger.getCurrentStepId?.(trajectoryId);
          expect(evaluatorStepId).not.toBe(parentStepId);
          expect(typeof evaluatorStepId).toBe("string");
          logger.logLlmCall({
            ...llmCall(
              evaluatorStepId ?? "missing-evaluator-step",
              "openai",
              "gpt-evaluator",
              "evaluator result",
            ),
            purpose: "evaluation",
            actionType: "evaluator.real-quality-gate",
          });
        }),
    );
    await flushTrajectoryWrites(runtime, trajectoryId);
    await logger.endTrajectory(trajectoryId, "completed");

    const detail = await logger.getTrajectoryDetail(trajectoryId);
    const evaluatorStep = detail?.steps?.find(
      (step) => step.evaluatorName === "real-quality-gate",
    );
    expect(evaluatorStep).toMatchObject({
      parentStepId,
      kind: "evaluator",
      evaluatorName: "real-quality-gate",
      llmCalls: [expect.objectContaining({ model: "gpt-evaluator" })],
    });
    expect(
      detail?.steps?.find((step) => step.stepId === parentStepId)?.childSteps,
    ).toEqual([evaluatorStep?.stepId]);
  });

  it.each(["simple", "action"] as const)(
    "keeps %s-run post-turn telemetry inside one evaluator child before the terminal write",
    async (variant) => {
      const logger = runtime.getService(
        "trajectories",
      ) as unknown as LifecycleTrajLogger;
      const reportError = vi.spyOn(runtime, "reportError");
      const reportCallStart = reportError.mock.calls.length;
      const endSpy = vi.spyOn(logger, "endTrajectory");
      const message = {
        id: crypto.randomUUID(),
        agentId: runtime.agentId,
        entityId: runtime.agentId,
        roomId: crypto.randomUUID(),
        createdAt: Date.now(),
        content: { text: `${variant} post-turn ordering`, source: "chat" },
      } as Memory;
      await trajectoryEventHandler("MESSAGE_RECEIVED")({ runtime, message });
      const metadata = asRecord(message.metadata);
      const trajectoryId = metadata?.trajectoryId;
      const parentStepId = metadata?.trajectoryStepId;
      expect(typeof trajectoryId).toBe("string");
      expect(typeof parentStepId).toBe("string");
      if (
        typeof trajectoryId !== "string" ||
        typeof parentStepId !== "string"
      ) {
        return;
      }

      await flushTrajectoryWrites(runtime, trajectoryId);
      const initialDetail = await logger.getTrajectoryDetail(trajectoryId);
      const initialParentKind = initialDetail?.steps?.find(
        (step) => step.stepId === parentStepId,
      )?.kind;

      if (variant === "action") {
        const actionResult = await runWithTrajectoryContext(
          {
            trajectoryId,
            trajectoryStepId: parentStepId,
            purpose: "planner",
          },
          () =>
            executePlannedToolCall(
              runtime,
              { message, activeContexts: ["general"] },
              { name: "VIEWS", params: { view: "calendar" } },
            ),
        );
        expect(actionResult).toMatchObject({
          success: true,
          data: { actionName: "VIEWS", view: "calendar" },
        });
      }

      await trajectoryEventHandler("RUN_STARTED")({
        runtime,
        messageId: message.id,
      });
      await trajectoryEventHandler("MESSAGE_SENT")({
        runtime,
        message,
      });
      expect((await loadTrajectoryById(runtime, trajectoryId))?.status).toBe(
        "active",
      );

      let releaseEvaluation!: () => void;
      let markEvaluationStarted!: () => void;
      const evaluationGate = new Promise<void>((resolve) => {
        releaseEvaluation = resolve;
      });
      const evaluationStarted = new Promise<void>((resolve) => {
        markEvaluationStarted = resolve;
      });
      const evaluationWork = runWithTrajectoryContext(
        { trajectoryId, trajectoryStepId: parentStepId },
        () =>
          withEvaluatorStep(runtime, "post_turn", async () => {
            markEvaluationStarted();
            await evaluationGate;
            const evaluatorStepId = logger.getCurrentStepId?.(trajectoryId);
            expect(evaluatorStepId).not.toBe(parentStepId);
            expect(typeof evaluatorStepId).toBe("string");
            const capturedStepId = evaluatorStepId ?? "missing-evaluator-step";
            logger.logProviderAccess({
              stepId: capturedStepId,
              providerName: "post-turn-context",
              purpose: "evaluation",
              data: { variant },
            });
            logger.logLlmCall({
              ...llmCall(
                capturedStepId,
                "openai",
                `post-turn-${variant}`,
                "evaluation complete",
              ),
              purpose: "evaluation",
              actionType: "evaluator.post_turn",
            });
          }),
      );
      await evaluationStarted;
      expect((await loadTrajectoryById(runtime, trajectoryId))?.status).toBe(
        "active",
      );

      releaseEvaluation();
      await evaluationWork;
      await trajectoryEventHandler("RUN_ENDED")({
        runtime,
        messageId: message.id,
        status: "completed",
      });
      await flushTrajectoryWrites(runtime, trajectoryId);
      await logger.flushWriteQueue?.(trajectoryId);

      const detail = await logger.getTrajectoryDetail(trajectoryId);
      const evaluatorSteps = (detail?.steps ?? []).filter(
        (step) => step.evaluatorName === "post_turn",
      );
      expect(evaluatorSteps).toHaveLength(1);
      expect(evaluatorSteps[0]).toMatchObject({
        parentStepId,
        kind: "evaluator",
        providerAccesses: [
          expect.objectContaining({ providerName: "post-turn-context" }),
        ],
        llmCalls: [
          expect.objectContaining({
            model: `post-turn-${variant}`,
            purpose: "evaluation",
          }),
        ],
      });
      expect(
        detail?.steps?.find((step) => step.stepId === parentStepId)?.kind,
      ).toBe(initialParentKind);
      expect(
        detail?.steps?.filter((step) => step.action?.actionName === "VIEWS"),
      ).toHaveLength(variant === "action" ? 1 : 0);
      expect(
        endSpy.mock.calls.filter(([id]) => id === trajectoryId),
      ).toHaveLength(1);
      expect((await loadTrajectoryById(runtime, trajectoryId))?.status).toBe(
        "completed",
      );
      const evaluatorStepId = evaluatorSteps[0]?.stepId;
      const orphanRows = await executeRawSql(
        runtime,
        `SELECT id FROM trajectories WHERE id = '${String(
          evaluatorStepId,
        ).replaceAll("'", "''")}'`,
      );
      expect(extractRows(orphanRows)).toEqual([]);
      expect(
        reportError.mock.calls
          .slice(reportCallStart)
          .filter(([scope]) => scope === "TrajectoryStorage.lateCapture"),
      ).toEqual([]);
      expect(__getTrajectoryBridgeStateCountsForTests(runtime)).toEqual({
        stepMappings: 0,
        activeOwners: 0,
      });
      endSpy.mockRestore();
      reportError.mockRestore();
    },
  );

  it("keeps concurrent-room evaluator children independently active until each run ends", async () => {
    const logger = runtime.getService(
      "trajectories",
    ) as unknown as LifecycleTrajLogger;
    const reportError = vi.spyOn(runtime, "reportError");
    const reportCallStart = reportError.mock.calls.length;
    const endSpy = vi.spyOn(logger, "endTrajectory");
    const turns = await Promise.all(
      ["first", "second"].map(async (label) => {
        const message = {
          id: crypto.randomUUID(),
          agentId: runtime.agentId,
          entityId: runtime.agentId,
          roomId: crypto.randomUUID(),
          createdAt: Date.now(),
          content: { text: `${label} concurrent room`, source: "chat" },
        } as Memory;
        await trajectoryEventHandler("MESSAGE_RECEIVED")({ runtime, message });
        const metadata = asRecord(message.metadata);
        const trajectoryId = metadata?.trajectoryId;
        const parentStepId = metadata?.trajectoryStepId;
        expect(typeof trajectoryId).toBe("string");
        expect(typeof parentStepId).toBe("string");
        if (
          typeof trajectoryId !== "string" ||
          typeof parentStepId !== "string"
        ) {
          throw new Error(`Missing ${label} trajectory metadata`);
        }
        await trajectoryEventHandler("RUN_STARTED")({
          runtime,
          messageId: message.id,
        });
        await trajectoryEventHandler("MESSAGE_SENT")({
          runtime,
          message,
        });
        let release!: () => void;
        let markStarted!: () => void;
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        const started = new Promise<void>((resolve) => {
          markStarted = resolve;
        });
        const work = runWithTrajectoryContext(
          { trajectoryId, trajectoryStepId: parentStepId },
          () =>
            withEvaluatorStep(runtime, "post_turn", async () => {
              markStarted();
              await gate;
              const evaluatorStepId = logger.getCurrentStepId?.(trajectoryId);
              if (!evaluatorStepId) {
                throw new Error(`Missing ${label} evaluator step`);
              }
              logger.logProviderAccess({
                stepId: evaluatorStepId,
                providerName: `post-turn-${label}`,
                purpose: "evaluation",
                data: { roomId: message.roomId },
              });
              logger.logLlmCall({
                ...llmCall(
                  evaluatorStepId,
                  "openai",
                  `concurrent-${label}`,
                  `${label} evaluation`,
                ),
                purpose: "evaluation",
              });
            }),
        );
        return {
          label,
          message,
          trajectoryId,
          release,
          started,
          work,
        };
      }),
    );
    await Promise.all(turns.map((turn) => turn.started));
    expect(
      await Promise.all(
        turns.map(
          async (turn) =>
            (await loadTrajectoryById(runtime, turn.trajectoryId))?.status,
        ),
      ),
    ).toEqual(["active", "active"]);

    turns[0].release();
    await turns[0].work;
    await trajectoryEventHandler("RUN_ENDED")({
      runtime,
      messageId: turns[0].message.id,
      status: "completed",
    });
    expect(
      (await loadTrajectoryById(runtime, turns[0].trajectoryId))?.status,
    ).toBe("completed");
    expect(
      (await loadTrajectoryById(runtime, turns[1].trajectoryId))?.status,
    ).toBe("active");

    turns[1].release();
    await turns[1].work;
    await trajectoryEventHandler("RUN_ENDED")({
      runtime,
      messageId: turns[1].message.id,
      status: "completed",
    });
    await flushTrajectoryWrites(runtime);
    for (const turn of turns) {
      await logger.flushWriteQueue?.(turn.trajectoryId);
      const detail = await logger.getTrajectoryDetail(turn.trajectoryId);
      const evaluatorSteps = (detail?.steps ?? []).filter(
        (step) => step.evaluatorName === "post_turn",
      );
      expect(evaluatorSteps).toHaveLength(1);
      expect(evaluatorSteps[0]).toMatchObject({
        parentStepId: expect.any(String),
        providerAccesses: expect.arrayContaining([
          expect.objectContaining({ providerName: `post-turn-${turn.label}` }),
        ]),
        llmCalls: expect.arrayContaining([
          expect.objectContaining({ model: `concurrent-${turn.label}` }),
        ]),
      });
      expect(
        endSpy.mock.calls.filter(([id]) => id === turn.trajectoryId),
      ).toHaveLength(1);
      expect(
        (await loadTrajectoryById(runtime, turn.trajectoryId))?.status,
      ).toBe("completed");
      const evaluatorStepId = evaluatorSteps[0]?.stepId;
      const orphanRows = await executeRawSql(
        runtime,
        `SELECT id FROM trajectories WHERE id = '${String(
          evaluatorStepId,
        ).replaceAll("'", "''")}'`,
      );
      expect(extractRows(orphanRows)).toEqual([]);
    }
    const activeRows = await executeRawSql(
      runtime,
      `SELECT id FROM trajectories WHERE id IN (${turns
        .map((turn) => `'${turn.trajectoryId.replaceAll("'", "''")}'`)
        .join(", ")}) AND status = 'active'`,
    );
    expect(extractRows(activeRows)).toEqual([]);
    expect(
      reportError.mock.calls
        .slice(reportCallStart)
        .filter(([scope]) => scope === "TrajectoryStorage.lateCapture"),
    ).toEqual([]);
    expect(__getTrajectoryBridgeStateCountsForTests(runtime)).toEqual({
      stepMappings: 0,
      activeOwners: 0,
    });
    endSpy.mockRestore();
    reportError.mockRestore();
  });

  it("drains a real message-service post-turn provider and model before the PGlite terminal", async () => {
    const logger = runtime.getService(
      "trajectories",
    ) as unknown as LifecycleTrajLogger;
    const reportError = vi.spyOn(runtime, "reportError");
    const reportCallStart = reportError.mock.calls.length;
    const endSpy = vi.spyOn(logger, "endTrajectory");
    let releaseModel!: () => void;
    let markModelStarted!: () => void;
    const modelGate = new Promise<void>((resolve) => {
      releaseModel = resolve;
    });
    const modelStarted = new Promise<void>((resolve) => {
      markModelStarted = resolve;
    });
    const providerName = `POST_TURN_TERMINAL_${crypto.randomUUID()}`;
    const actionName = `POST_TURN_TERMINAL_ACTION_${crypto.randomUUID()}`;
    const provider: Provider = {
      name: providerName,
      description: "Test-only post-turn context.",
      private: true,
      get: async () => ({
        text: "post-turn provider context",
        data: { proof: "provider-captured-before-terminal" },
      }),
    };
    const afterAction: Action = {
      name: actionName,
      description: "Run gated post-turn telemetry.",
      similes: [],
      examples: [],
      mode: "ALWAYS_AFTER",
      validate: async () => true,
      handler: async (actionRuntime, actionMessage) => {
        const context = getTrajectoryContext();
        expect(context?.purpose).toBe("evaluation");
        await actionRuntime.composeState(
          actionMessage,
          [providerName],
          true,
          true,
        );
        await actionRuntime.useModel(ModelType.TEXT_LARGE, {
          prompt: "Complete the gated post-turn diagnostic.",
        });
        return { success: true, text: "post-turn complete" };
      },
    };
    runtime.registerProvider(provider);
    runtime.registerAction(afterAction);
    runtime.registerModel(
      ModelType.TEXT_EMBEDDING,
      async () => [0.1, 0.2, 0.3],
      "terminal-owner-embedding",
      10_000,
    );
    runtime.registerModel(
      ModelType.RESPONSE_HANDLER,
      async () => directResponseEnvelope("Delivery completed immediately."),
      "terminal-owner-response",
      10_000,
    );
    runtime.registerModel(
      ModelType.TEXT_LARGE,
      async () => {
        markModelStarted();
        await modelGate;
        return "post-turn model complete";
      },
      "terminal-owner-post-turn",
      10_000,
    );

    const entityId = crypto.randomUUID() as UUID;
    const roomId = crypto.randomUUID() as UUID;
    await runtime.ensureConnection({
      entityId,
      roomId,
      worldId: crypto.randomUUID() as UUID,
      userName: "Terminal Owner User",
      name: "Terminal Owner User",
      source: "client_chat",
      type: ChannelType.DM,
      channelId: `client_chat:${roomId}`,
    });
    const message = {
      id: crypto.randomUUID() as UUID,
      agentId: runtime.agentId,
      entityId,
      roomId,
      createdAt: Date.now(),
      content: {
        text: "remember this real message-service terminal proof",
        source: "client_chat",
        channelType: "DM",
      },
    } as Memory;
    const deliveries: string[] = [];
    const service = new DefaultMessageService();

    try {
      const result = await service.handleMessage(
        runtime,
        message,
        async (content) => {
          if (content.text) deliveries.push(content.text);
          return [];
        },
      );
      await modelStarted;
      expect(result.trajectoryTerminalOwner).toBe("run");
      expect(deliveries).toContain("Delivery completed immediately.");

      const metadata = asRecord(message.metadata);
      const trajectoryId = metadata?.trajectoryId;
      const parentStepId = metadata?.trajectoryStepId;
      expect(typeof trajectoryId).toBe("string");
      expect(typeof parentStepId).toBe("string");
      if (
        typeof trajectoryId !== "string" ||
        typeof parentStepId !== "string"
      ) {
        throw new Error("Message service did not retain trajectory ownership");
      }
      await flushTrajectoryWrites(runtime, trajectoryId);
      await logger.flushWriteQueue?.(trajectoryId);
      const activeDetail = await logger.getTrajectoryDetail(trajectoryId);
      const parentKind = activeDetail?.steps?.find(
        (step) => step.stepId === parentStepId,
      )?.kind;
      expect((await loadTrajectoryById(runtime, trajectoryId))?.status).toBe(
        "active",
      );
      expect(
        endSpy.mock.calls.filter(([id]) => id === trajectoryId),
      ).toHaveLength(0);

      releaseModel();
      await drainPostDeliveryTasks(runtime);
      await flushTrajectoryWrites(runtime, trajectoryId);
      await logger.flushWriteQueue?.(trajectoryId);

      const detail = await logger.getTrajectoryDetail(trajectoryId);
      const evaluatorSteps = (detail?.steps ?? []).filter(
        (step) => step.evaluatorName === "post_turn",
      );
      expect(evaluatorSteps).toHaveLength(1);
      expect(evaluatorSteps[0]).toMatchObject({
        parentStepId,
        kind: "evaluator",
        llmCalls: expect.arrayContaining([
          expect.objectContaining({
            provider: "terminal-owner-post-turn",
            purpose: "evaluation",
          }),
        ]),
      });
      expect(
        detail?.steps?.flatMap((step) => step.providerAccesses ?? []),
      ).toEqual(
        expect.arrayContaining([expect.objectContaining({ providerName })]),
      );
      expect(
        detail?.steps?.find((step) => step.stepId === parentStepId)?.kind,
      ).toBe(parentKind);
      expect(
        endSpy.mock.calls.filter(([id]) => id === trajectoryId),
      ).toHaveLength(1);
      expect((await loadTrajectoryById(runtime, trajectoryId))?.status).toBe(
        "completed",
      );

      const listRoute = await readRoute("/api/trajectories");
      expect(listRoute.status).toBe(200);
      expect(asRecord(listRoute.body)?.trajectories).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: trajectoryId })]),
      );
      const detailRoute = await readRoute(`/api/trajectories/${trajectoryId}`);
      expect(detailRoute.status).toBe(200);
      expect(asRecord(detailRoute.body)?.llmCalls).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ provider: "terminal-owner-post-turn" }),
        ]),
      );
      expect(asRecord(detailRoute.body)?.providerAccesses).toEqual(
        expect.arrayContaining([expect.objectContaining({ providerName })]),
      );

      const evaluatorStepId = evaluatorSteps[0]?.stepId;
      const orphanRows = await executeRawSql(
        runtime,
        `SELECT id FROM trajectories WHERE id = '${String(
          evaluatorStepId,
        ).replaceAll("'", "''")}'`,
      );
      expect(extractRows(orphanRows)).toEqual([]);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await drainPostDeliveryTasks(runtime);
      await flushTrajectoryWrites(runtime, trajectoryId);
      expect(
        reportError.mock.calls
          .slice(reportCallStart)
          .filter(([scope]) => scope === "TrajectoryStorage.lateCapture"),
      ).toEqual([]);
      expect(__getTrajectoryBridgeStateCountsForTests(runtime)).toEqual({
        stepMappings: 0,
        activeOwners: 0,
      });
    } finally {
      const providerIndex = runtime.providers.indexOf(provider);
      if (providerIndex >= 0) runtime.providers.splice(providerIndex, 1);
      const actionIndex = runtime.actions.indexOf(afterAction);
      if (actionIndex >= 0) runtime.actions.splice(actionIndex, 1);
      for (const modelType of [
        ModelType.TEXT_EMBEDDING,
        ModelType.RESPONSE_HANDLER,
        ModelType.TEXT_LARGE,
      ]) {
        const modelKey = String(modelType);
        const registrations = runtime.models.get(modelKey);
        if (!registrations) continue;
        const retained = registrations.filter(
          (registration) =>
            !registration.provider.startsWith("terminal-owner-"),
        );
        if (retained.length === 0) runtime.models.delete(modelKey);
        else runtime.models.set(modelKey, retained);
      }
      endSpy.mockRestore();
      reportError.mockRestore();
      releaseModel();
    }
  });

  it("keeps dedicated steps authoritative for long captures, scripts, skills, evaluators, and exports", async () => {
    const logger = runtime.getService("trajectories") as unknown as TrajLogger;
    const startedAt = Date.now();
    const trajectoryId = crypto.randomUUID();
    const parentStepId = crypto.randomUUID();
    const evaluatorStepId = crypto.randomUUID();
    const actionStepId = crypto.randomUUID();
    const longScript = "return input;\n".repeat(6_000);
    expect(longScript.length).toBeGreaterThan(65_536);

    const trajectory = createBaseTrajectory(
      trajectoryId,
      startedAt,
      runtime.agentId,
      "test",
      {
        roomId: "room-authority",
        entityId: "entity-authority",
        conversationId: "conversation-authority",
      },
    );
    trajectory.steps[0] = {
      ...trajectory.steps[0],
      stepId: parentStepId,
      childSteps: [evaluatorStepId, actionStepId],
    };
    trajectory.steps.push({
      stepId: evaluatorStepId,
      parentStepId,
      stepNumber: 1,
      timestamp: startedAt + 1,
      kind: "evaluator",
      evaluatorName: "quality-gate",
      llmCalls: Array.from({ length: 260 }, (_, index) => ({
        ...llmCall(evaluatorStepId, "openai", "gpt-5.5", `evaluation-${index}`),
        callId: `${evaluatorStepId}-call-${index}`,
        timestamp: startedAt + index + 2,
        purpose: "evaluation",
        actionType: "evaluator.quality-gate",
      })),
      providerAccesses: [],
      usedSkills: ["calendar-review"],
      skillInvocations: [
        {
          skillSlug: "calendar-review",
          durationMs: 4,
          parentStepId,
          success: true,
          startedAt: startedAt + 1,
          mode: "guidance",
          result: "accepted",
        },
      ],
    });
    trajectory.steps.push({
      stepId: actionStepId,
      parentStepId,
      stepNumber: 2,
      timestamp: startedAt + 300,
      kind: "action",
      llmCalls: [
        {
          ...llmCall(
            actionStepId,
            "openai",
            "gpt-script",
            "script-backed action",
          ),
          callId: `${actionStepId}-call`,
          timestamp: startedAt + 300,
        },
      ],
      providerAccesses: [],
      script: longScript,
      action: {
        attemptId: `${actionStepId}-attempt`,
        timestamp: startedAt + 300,
        actionType: "action",
        actionName: "VIEWS",
        parameters: { view: "calendar" },
        success: true,
        result: { opened: "calendar" },
      },
    });
    trajectory.metrics = { successRate: 1, errorCount: 0 };
    trajectory.status = "completed";
    trajectory.endTime = startedAt + 500;
    trajectory.updatedAt = new Date(startedAt + 500).toISOString();
    await saveTrajectory(runtime, trajectory);

    const reloadedRuntime = sharedDatabaseRuntime(runtime.agentId);
    const byChild = await loadTrajectoryByStepId(reloadedRuntime, actionStepId);
    expect(byChild?.id).toBe(trajectoryId);
    expect(byChild?.steps).toHaveLength(3);
    expect(byChild?.steps[1]).toMatchObject({
      evaluatorName: "quality-gate",
      usedSkills: ["calendar-review"],
      skillInvocations: [
        expect.objectContaining({
          skillSlug: "calendar-review",
          success: true,
        }),
      ],
    });
    expect(byChild?.steps[1]?.llmCalls).toHaveLength(260);
    expect(byChild?.steps[2]?.script).toBe(longScript);

    const legacyResult = await executeRawSql(
      runtime,
      `SELECT steps_json, llm_call_count FROM trajectories
       WHERE id = '${trajectoryId}'`,
    );
    const legacyRow = asRecord(extractRows(legacyResult)[0]);
    const legacySteps = (
      typeof legacyRow?.steps_json === "string"
        ? JSON.parse(legacyRow.steps_json)
        : legacyRow?.steps_json
    ) as Array<{
      script?: string;
      scriptHash?: string;
    }>;
    expect(legacySteps[2]?.script?.length).toBeLessThan(longScript.length);
    expect(legacySteps[2]?.scriptHash).toMatch(/^[a-f0-9]{64}$/);
    expect(Number(legacyRow?.llm_call_count)).toBe(261);

    const publicStepId = crypto.randomUUID();
    const authorityAdapter = (
      runtime as unknown as {
        adapter: {
          db: {
            execute: (query: unknown) => Promise<unknown>;
            transaction: <T>(
              callback: (tx: {
                execute: (query: unknown) => Promise<unknown>;
              }) => Promise<T>,
            ) => Promise<T>;
          };
        };
      }
    ).adapter;
    const authorityDb = authorityAdapter.db;
    const incrementalSql: string[] = [];
    authorityAdapter.db = {
      execute: async (query) => {
        incrementalSql.push(sqlText(query));
        return authorityDb.execute(query);
      },
      transaction: <T>(
        callback: (tx: {
          execute: (query: unknown) => Promise<unknown>;
        }) => Promise<T>,
      ): Promise<T> =>
        authorityDb.transaction((tx) =>
          callback({
            execute: async (query) => {
              incrementalSql.push(sqlText(query));
              return tx.execute(query);
            },
          }),
        ),
    };
    try {
      await upsertStep(runtime, trajectoryId, {
        stepId: publicStepId,
        parentStepId,
        stepNumber: 3,
        timestamp: startedAt + 400,
        llmCalls: [
          {
            ...llmCall(
              publicStepId,
              "openai",
              "gpt-public",
              "public CQRS capture",
            ),
            callId: `${publicStepId}-call`,
            timestamp: startedAt + 400,
          },
        ],
        providerAccesses: [],
        kind: "action",
        action: {
          attemptId: `${publicStepId}-attempt`,
          timestamp: startedAt + 400,
          actionType: "action",
          actionName: "PUBLIC_CQRS",
          parameters: {},
          success: true,
          result: { persisted: true },
        },
      });
    } finally {
      authorityAdapter.db = authorityDb;
    }
    expect(
      incrementalSql.filter((text) =>
        /INSERT INTO trajectory_steps\s*\(/i.test(text),
      ),
    ).toHaveLength(1);
    expect(
      incrementalSql.some((text) => /DELETE FROM trajectory_steps/i.test(text)),
    ).toBe(false);
    const detail = await logger.getTrajectoryDetail(trajectoryId);
    expect(detail?.steps).toHaveLength(4);
    expect(detail?.metrics).toMatchObject({
      successRate: 1,
      errorCount: 0,
      episodeLength: 4,
      finalStatus: "completed",
    });
    expect(
      detail?.steps?.find((step) => step.stepId === publicStepId)?.action,
    ).toMatchObject({ actionName: "PUBLIC_CQRS", success: true });

    const exported = await logger.exportTrajectories({
      format: "jsonl",
      trajectoryIds: [trajectoryId],
    });
    const exportedRows = String(exported.data)
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(exportedRows).toHaveLength(262);
    const exportedMetadata = exportedRows.map((row) => asRecord(row.metadata));
    expect(
      exportedMetadata.some(
        (metadata) =>
          asRecord(metadata?.trajectory_step)?.evaluatorName === "quality-gate",
      ),
    ).toBe(true);
    expect(
      exportedMetadata.some((metadata) => {
        const usedSkills = asRecord(metadata?.trajectory_step)?.usedSkills;
        return (
          Array.isArray(usedSkills) && usedSkills.includes("calendar-review")
        );
      }),
    ).toBe(true);
    expect(
      exportedMetadata.some(
        (metadata) =>
          asRecord(asRecord(metadata?.trajectory_step)?.action)?.actionName ===
          "PUBLIC_CQRS",
      ),
    ).toBe(true);
    expect(
      exportedMetadata.some(
        (metadata) =>
          asRecord(metadata?.trajectory_step)?.script === longScript,
      ),
    ).toBe(true);
    expect(
      exportedMetadata.some(
        (metadata) => asRecord(metadata?.trajectory_metrics)?.successRate === 1,
      ),
    ).toBe(true);

    const storedList = await logger.listTrajectories({ limit: 500, offset: 0 });
    expect(storedList.trajectories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: trajectoryId,
          roomId: "room-authority",
          entityId: "entity-authority",
          conversationId: "conversation-authority",
          llmCallCount: 262,
          stepCount: 4,
        }),
      ]),
    );

    const listRoute = await readRoute("/api/trajectories");
    expect(asRecord(listRoute.body)?.trajectories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: trajectoryId,
          roomId: "room-authority",
          entityId: "entity-authority",
          llmCallCount: 262,
          metadata: expect.objectContaining({
            conversationId: "conversation-authority",
          }),
        }),
      ]),
    );
  });

  it("rolls back partial step replacement and preserves two-agent isolation", async () => {
    const baseDb = (
      runtime as unknown as {
        adapter: {
          db: {
            execute: (query: unknown) => Promise<unknown>;
            transaction: <T>(
              callback: (tx: {
                execute: (query: unknown) => Promise<unknown>;
              }) => Promise<T>,
            ) => Promise<T>;
          };
        };
      }
    ).adapter.db;
    let stepInsert = 0;
    const faultDb = {
      execute: baseDb.execute.bind(baseDb),
      transaction: <T>(
        callback: (tx: {
          execute: (query: unknown) => Promise<unknown>;
        }) => Promise<T>,
      ): Promise<T> =>
        baseDb.transaction((tx) =>
          callback({
            execute: async (query) => {
              const text = sqlText(query);
              if (
                /INSERT INTO trajectory_steps/i.test(text) &&
                ++stepInsert === 2
              ) {
                throw new Error("injected second-step failure");
              }
              return tx.execute(query);
            },
          }),
        ),
    };
    const faultRuntime = sharedDatabaseRuntime(runtime.agentId);
    (faultRuntime as unknown as { adapter: { db: unknown } }).adapter = {
      db: faultDb,
    };
    const trajectoryId = crypto.randomUUID();
    const startedAt = Date.now();
    const trajectory = createBaseTrajectory(
      trajectoryId,
      startedAt,
      runtime.agentId,
      "fault-test",
    );
    trajectory.steps.push({
      stepId: crypto.randomUUID(),
      stepNumber: 1,
      timestamp: startedAt + 1,
      llmCalls: [],
      providerAccesses: [],
    });
    await expect(saveTrajectory(faultRuntime, trajectory)).rejects.toThrow(
      "Could not save trajectory steps",
    );
    const rolledBack = await executeRawSql(
      runtime,
      `SELECT id FROM trajectories WHERE id = '${trajectoryId}'`,
    );
    expect(extractRows(rolledBack)).toEqual([]);
    await saveTrajectory(runtime, trajectory);
    expect(
      (await loadTrajectoryById(runtime, trajectoryId))?.steps,
    ).toHaveLength(2);

    const otherRuntime = sharedDatabaseRuntime(crypto.randomUUID());
    const otherLogger = new DatabaseTrajectoryLogger(otherRuntime);
    const otherTrajectoryId = crypto.randomUUID();
    const other = createBaseTrajectory(
      otherTrajectoryId,
      startedAt + 10,
      otherRuntime.agentId,
      "other-agent",
    );
    await saveTrajectory(otherRuntime, other);

    const ownRows = await loadPersistedTrajectoryRows(otherRuntime);
    expect(ownRows.map((row) => row.id)).toContain(otherTrajectoryId);
    expect(ownRows.map((row) => row.id)).not.toContain(trajectoryId);
    expect(await otherLogger.getTrajectoryDetail(trajectoryId)).toBeNull();
    expect(
      (
        await otherLogger.listTrajectories({ limit: 500, offset: 0 })
      ).trajectories.map((item) => item.id),
    ).not.toContain(trajectoryId);
    expect(
      String(
        (
          await otherLogger.exportTrajectories({
            format: "jsonl",
            trajectoryIds: [trajectoryId],
          })
        ).data,
      ),
    ).not.toContain(trajectoryId);
    expect((await getSteps(otherRuntime, trajectoryId)).steps).toEqual([]);

    const forged = {
      ...trajectory,
      agentId: otherRuntime.agentId,
      updatedAt: new Date().toISOString(),
    };
    await expect(saveTrajectory(otherRuntime, forged)).rejects.toMatchObject({
      code: "TRAJECTORY_AGENT_OWNERSHIP_CONFLICT",
    });
    expect(await otherLogger.deleteTrajectories([trajectoryId])).toBe(0);
    expect(await deleteStepsForTrajectories(otherRuntime, [trajectoryId])).toBe(
      0,
    );
    expect(await clearAllSteps(otherRuntime)).toBe(1);
    expect((await getSteps(runtime, trajectoryId)).steps).toHaveLength(2);
    expect(await otherLogger.deleteTrajectories([otherTrajectoryId])).toBe(1);
  });

  it("retries terminal durability once, claims concurrent endings, and rejects late or malformed capture", async () => {
    const logger = runtime.getService("trajectories") as unknown as TrajLogger;
    const reportError = vi.spyOn(runtime, "reportError");
    reportError.mockClear();
    const message = {
      id: crypto.randomUUID(),
      agentId: runtime.agentId,
      entityId: runtime.agentId,
      roomId: crypto.randomUUID(),
      createdAt: Date.now(),
      content: { text: "Retry terminal persistence", source: "chat" },
    } as Memory;
    await trajectoryEventHandler("MESSAGE_RECEIVED")({ runtime, message });
    const trajectoryId = asRecord(message.metadata)?.trajectoryId;
    expect(typeof trajectoryId).toBe("string");
    if (typeof trajectoryId !== "string") return;

    const adapter = (
      runtime as unknown as {
        adapter: {
          db: {
            execute: (query: unknown) => Promise<unknown>;
            transaction: <T>(
              callback: (tx: {
                execute: (query: unknown) => Promise<unknown>;
              }) => Promise<T>,
            ) => Promise<T>;
          };
        };
      }
    ).adapter;
    const baseDb = adapter.db;
    let failTerminalWrite = true;
    adapter.db = {
      execute: baseDb.execute.bind(baseDb),
      transaction: <T>(
        callback: (tx: {
          execute: (query: unknown) => Promise<unknown>;
        }) => Promise<T>,
      ): Promise<T> =>
        baseDb.transaction((tx) =>
          callback({
            execute: async (query) => {
              if (
                failTerminalWrite &&
                /(?:INSERT INTO|UPDATE)\s+trajectories/i.test(sqlText(query))
              ) {
                failTerminalWrite = false;
                throw new Error("injected terminal write failure");
              }
              return tx.execute(query);
            },
          }),
        ),
    };
    try {
      await trajectoryEventHandler("RUN_ENDED")({
        runtime,
        messageId: message.id,
        status: "error",
      });
    } finally {
      adapter.db = baseDb;
    }
    const terminalRow = asRecord(
      extractRows(
        await executeRawSql(
          runtime,
          `SELECT status FROM trajectories WHERE id = '${trajectoryId}'`,
        ),
      )[0],
    );
    expect(terminalRow?.status).toBe("terminated");
    expect(
      reportError.mock.calls.some(
        ([scope, , context]) =>
          scope === "TrajectoriesPlugin.endRetry" &&
          asRecord(context)?.diagnosticOnly === true,
      ),
    ).toBe(true);
    expect(__getTrajectoryBridgeStateCountsForTests(runtime)).toEqual({
      stepMappings: 0,
      activeOwners: 0,
    });

    const concurrentMessage = {
      id: crypto.randomUUID(),
      agentId: runtime.agentId,
      entityId: runtime.agentId,
      roomId: crypto.randomUUID(),
      createdAt: Date.now(),
      content: { text: "Concurrent terminal events", source: "chat" },
    } as Memory;
    await trajectoryEventHandler("MESSAGE_RECEIVED")({
      runtime,
      message: concurrentMessage,
    });
    const endSpy = vi.spyOn(logger, "endTrajectory");
    await Promise.all([
      trajectoryEventHandler("RUN_ENDED")({
        runtime,
        messageId: concurrentMessage.id,
        status: "completed",
      }),
      trajectoryEventHandler("RUN_ENDED")({
        runtime,
        messageId: concurrentMessage.id,
        status: "error",
      }),
    ]);
    expect(endSpy).toHaveBeenCalledTimes(1);
    endSpy.mockRestore();

    const countBeforeMissingId = Number(
      asRecord(
        extractRows(
          await executeRawSql(
            runtime,
            `SELECT count(*) AS total FROM trajectories
             WHERE agent_id = '${runtime.agentId}'`,
          ),
        )[0],
      )?.total,
    );
    const missingIdMessage = {
      agentId: runtime.agentId,
      entityId: runtime.agentId,
      roomId: crypto.randomUUID(),
      createdAt: Date.now(),
      content: { text: "No id", source: "chat" },
    } as Memory;
    await trajectoryEventHandler("MESSAGE_RECEIVED")({
      runtime,
      message: missingIdMessage,
    });
    const countAfterMissingId = Number(
      asRecord(
        extractRows(
          await executeRawSql(
            runtime,
            `SELECT count(*) AS total FROM trajectories
             WHERE agent_id = '${runtime.agentId}'`,
          ),
        )[0],
      )?.total,
    );
    expect(countAfterMissingId).toBe(countBeforeMissingId);
    expect(asRecord(missingIdMessage.metadata)?.trajectoryId).toBeUndefined();

    const captureTrajectoryId = await logger.startTrajectory(runtime.agentId, {
      source: "test",
    });
    const childStepId = logger.startStep(captureTrajectoryId);
    logger.logLlmCall({ stepId: childStepId, model: "missing-contract" });
    logger.logProviderAccess({
      stepId: childStepId,
      providerName: "missing-data",
      purpose: "context",
    });
    logger.logLlmCall({
      ...llmCall(childStepId, "openai", "malformed-optional", "reject me"),
      promptTokens: "0" as unknown as number,
    });
    logger.logProviderAccess({
      stepId: childStepId,
      providerName: "malformed-duration",
      purpose: "context",
      data: {},
      durationMs: "0" as unknown as number,
    });
    logger.logLlmCall({
      ...llmCall(childStepId, "openai", "gpt-zero", "valid zero values"),
      temperature: 0,
      maxTokens: 0,
      latencyMs: 0,
    });
    await flushTrajectoryWrites(runtime, captureTrajectoryId);
    const activeDetail = await logger.getTrajectoryDetail(captureTrajectoryId);
    expect(
      activeDetail?.steps?.find((step) => step.stepId === childStepId)
        ?.llmCalls,
    ).toEqual([
      expect.objectContaining({
        model: "gpt-zero",
        temperature: 0,
        maxTokens: 0,
        latencyMs: 0,
      }),
    ]);
    await logger.endTrajectory(captureTrajectoryId, "completed");
    logger.logLlmCall(
      llmCall(childStepId, "openai", "late-model", "must be rejected"),
    );
    logger.logProviderAccess({
      stepId: childStepId,
      providerName: "late-provider",
      purpose: "context",
      data: {},
    });
    await flushTrajectoryWrites(runtime);
    const afterLate = await logger.getTrajectoryDetail(captureTrajectoryId);
    expect(
      afterLate?.steps?.flatMap((step) => step.llmCalls ?? []),
    ).toHaveLength(1);
    expect(
      afterLate?.steps?.flatMap((step) => step.providerAccesses ?? []),
    ).toHaveLength(0);
    expect(
      reportError.mock.calls.filter(
        ([scope, , context]) =>
          [
            "TrajectoryStorage.captureValidation",
            "TrajectoryStorage.lateCapture",
          ].includes(String(scope)) &&
          asRecord(context)?.diagnosticOnly === true,
      ),
    ).toHaveLength(6);
  });

  it("keeps the standalone database logger closed after end and stop", async () => {
    const publicRuntime = sharedDatabaseRuntime(crypto.randomUUID());
    const publicLogger = new DatabaseTrajectoryLogger(publicRuntime);
    publicLogger.setEnabled(true);
    const trajectoryId = crypto.randomUUID();
    const started = await publicLogger.startTrajectory(trajectoryId, {
      agentId: publicRuntime.agentId,
      source: "standalone-real",
    });
    const childStepId = publicLogger.startStep(started);
    const liveCall = {
      ...llmCall(childStepId, "openai", "standalone-live", "captured once"),
      callId: "standalone-live-call",
    };
    publicLogger.logLlmCall(liveCall);
    await publicLogger.flushWriteQueue(started);
    await publicLogger.endTrajectory(started, "completed");

    // A recorder can retransmit its already-durable capture after the owner
    // closes. Stable identity makes that exact retry a quiet no-op.
    publicLogger.logLlmCall(liveCall);
    publicLogger.logLlmCall({
      ...llmCall(childStepId, "openai", "standalone-late", "must be rejected"),
      callId: "standalone-new-late-call",
    });
    publicLogger.logProviderAccess({
      stepId: childStepId,
      providerName: "standalone-late-provider",
      purpose: "context",
      data: {},
    });
    await publicLogger.flushWriteQueue();

    const completed = await loadTrajectoryById(publicRuntime, started);
    expect(completed?.status).toBe("completed");
    expect(
      completed?.steps
        .flatMap((step) => step.llmCalls)
        .map((call) => call.model),
    ).toEqual(["standalone-live"]);
    expect(completed?.steps.flatMap((step) => step.providerAccesses)).toEqual(
      [],
    );
    const orphanRows = extractRows(
      await executeRawSql(
        publicRuntime,
        `SELECT id FROM trajectories WHERE id = '${childStepId}'`,
      ),
    );
    expect(orphanRows).toEqual([]);
    expect(__getTrajectoryBridgeStateCountsForTests(publicRuntime)).toEqual({
      stepMappings: 0,
      activeOwners: 0,
    });
    expect(
      (publicRuntime.reportError as unknown as ReturnType<typeof vi.fn>).mock
        .calls,
    ).toEqual(
      expect.arrayContaining([
        [
          "TrajectoryStorage.lateCapture",
          expect.objectContaining({ code: "TRAJECTORY_OWNER_CLOSED" }),
          expect.objectContaining({ diagnosticOnly: true, captureType: "llm" }),
        ],
        [
          "TrajectoryStorage.lateCapture",
          expect.objectContaining({ code: "TRAJECTORY_OWNER_CLOSED" }),
          expect.objectContaining({
            diagnosticOnly: true,
            captureType: "provider",
          }),
        ],
      ]),
    );
    expect(
      (
        publicRuntime.reportError as unknown as ReturnType<typeof vi.fn>
      ).mock.calls.filter(
        ([scope]) => String(scope) === "TrajectoryStorage.lateCapture",
      ),
    ).toHaveLength(2);

    await publicLogger.stop();
    const countBefore = Number(
      asRecord(
        extractRows(
          await executeRawSql(
            publicRuntime,
            `SELECT count(*) AS total FROM trajectories WHERE agent_id = '${publicRuntime.agentId}'`,
          ),
        )[0],
      )?.total,
    );
    const inertId = await publicLogger.startTrajectory(crypto.randomUUID(), {
      agentId: publicRuntime.agentId,
      source: "after-stop",
    });
    publicLogger.startStep(inertId);
    publicLogger.logLlmCall(
      llmCall(childStepId, "openai", "after-stop", "must remain inert"),
    );
    await publicLogger.flushWriteQueue();
    const countAfter = Number(
      asRecord(
        extractRows(
          await executeRawSql(
            publicRuntime,
            `SELECT count(*) AS total FROM trajectories WHERE agent_id = '${publicRuntime.agentId}'`,
          ),
        )[0],
      )?.total,
    );
    expect(publicLogger.isEnabled()).toBe(false);
    expect(countAfter).toBe(countBefore);
    expect(__getTrajectoryBridgeStateCountsForTests(publicRuntime)).toEqual({
      stepMappings: 0,
      activeOwners: 0,
    });
  });

  it("uses persisted terminal status after reload and closed-id eviction", async () => {
    const createLogger = async (
      mode: "public" | "installed",
      agentId: string,
    ): Promise<{
      runtime: AgentRuntime;
      logger: LifecycleTrajLogger;
    }> => {
      if (mode === "installed") return installedDatabaseLogger(agentId);
      const publicRuntime = sharedDatabaseRuntime(agentId);
      const publicLogger = new DatabaseTrajectoryLogger(
        publicRuntime,
      ) as LifecycleTrajLogger;
      publicLogger.setEnabled?.(true);
      return { runtime: publicRuntime, logger: publicLogger };
    };

    for (const mode of ["public", "installed"] as const) {
      const agentId = crypto.randomUUID();
      const creator = await createLogger(mode, agentId);
      const ownerId = crypto.randomUUID();
      const trajectoryId = await creator.logger.startTrajectory(ownerId, {
        agentId,
        source: `${mode}-persisted-terminal`,
      });
      const childStepId = creator.logger.startStep(trajectoryId);
      creator.logger.logLlmCall(
        llmCall(
          childStepId,
          "openai",
          `${mode}-live-before-reload`,
          "captured once",
        ),
      );
      await flushTrajectoryWrites(creator.runtime, trajectoryId);
      await creator.logger.endTrajectory(trajectoryId, "completed");

      const reloaded = await createLogger(mode, agentId);
      reloaded.logger.logLlmCall(
        llmCall(
          childStepId,
          "openai",
          `${mode}-late-after-reload`,
          "must be rejected",
        ),
      );
      reloaded.logger.logProviderAccess({
        stepId: trajectoryId,
        providerName: `${mode}-late-provider-after-reload`,
        purpose: "context",
        data: {},
      });
      await flushTrajectoryWrites(reloaded.runtime);

      for (let index = 0; index <= 10_000; index += 1) {
        reloaded.logger.releaseTrajectoryOwnership(
          `${mode}-eviction-owner-${index}`,
        );
      }
      reloaded.logger.logLlmCall(
        llmCall(
          trajectoryId,
          "openai",
          `${mode}-late-after-eviction`,
          "must still be rejected",
        ),
      );
      reloaded.logger.logProviderAccess({
        stepId: childStepId,
        providerName: `${mode}-late-provider-after-eviction`,
        purpose: "context",
        data: {},
      });
      await flushTrajectoryWrites(reloaded.runtime);

      const persisted = await loadTrajectoryById(
        reloaded.runtime,
        trajectoryId,
      );
      expect(persisted?.status).toBe("completed");
      expect(
        persisted?.steps
          .flatMap((step) => step.llmCalls)
          .map((call) => call.model),
      ).toEqual([`${mode}-live-before-reload`]);
      expect(persisted?.steps.flatMap((step) => step.providerAccesses)).toEqual(
        [],
      );
      expect(
        extractRows(
          await executeRawSql(
            reloaded.runtime,
            `SELECT id, status FROM trajectories WHERE agent_id = '${agentId}'`,
          ),
        ),
      ).toEqual([
        expect.objectContaining({ id: trajectoryId, status: "completed" }),
      ]);
      expect(
        __getTrajectoryBridgeStateCountsForTests(reloaded.runtime),
      ).toEqual({ stepMappings: 0, activeOwners: 0 });
      expect(
        (
          reloaded.runtime.reportError as unknown as ReturnType<typeof vi.fn>
        ).mock.calls.filter(
          ([scope, error, context]) =>
            scope === "TrajectoryStorage.lateCapture" &&
            asRecord(error)?.code === "TRAJECTORY_OWNER_CLOSED" &&
            asRecord(context)?.diagnosticOnly === true,
        ),
      ).toHaveLength(4);

      await reloaded.logger.stop();
      await creator.logger.stop();
    }
  });

  it("atomically arbitrates fresh-runtime capture against parent terminalization", async () => {
    for (const mode of ["public", "installed"] as const) {
      for (const captureType of ["llm", "provider"] as const) {
        for (const ordering of ["end-first", "capture-first"] as const) {
          const scenario = `${mode}/${captureType}/${ordering}`;
          const agentId = crypto.randomUUID();
          const creator = await databaseLogger(mode, agentId);
          const gated = transactionGatedRuntime(agentId);
          const capture = await databaseLogger(
            mode,
            agentId,
            ordering === "end-first"
              ? gated.runtime
              : sharedDatabaseRuntime(agentId),
          );
          const terminal = await databaseLogger(
            mode,
            agentId,
            ordering === "capture-first"
              ? gated.runtime
              : sharedDatabaseRuntime(agentId),
          );
          const ownerId = crypto.randomUUID();
          let terminalPromise: Promise<void> | undefined;
          try {
            const trajectoryId = await creator.logger.startTrajectory(ownerId, {
              agentId,
              source: `atomic-${scenario}`,
            });
            const childStepId = creator.logger.startStep(trajectoryId);
            await flushTrajectoryWrites(creator.runtime, trajectoryId);

            const recordCapture = (): void => {
              if (captureType === "llm") {
                capture.logger.logLlmCall(
                  llmCall(
                    childStepId,
                    "openai",
                    `atomic-${scenario}`,
                    `capture ${scenario}`,
                  ),
                );
                return;
              }
              capture.logger.logProviderAccess({
                stepId: childStepId,
                providerName: `atomic-${scenario}`,
                purpose: "context",
                data: { scenario },
              });
            };

            gated.gate.arm();
            if (ordering === "end-first") {
              recordCapture();
              await gated.gate.entered;
              try {
                await terminal.logger.endTrajectory(trajectoryId, "completed");
              } finally {
                gated.gate.release();
              }
              await flushTrajectoryWrites(capture.runtime);
            } else {
              terminalPromise = terminal.logger.endTrajectory(
                trajectoryId,
                "completed",
              );
              await gated.gate.entered;
              try {
                recordCapture();
                await flushTrajectoryWrites(capture.runtime);
              } finally {
                gated.gate.release();
              }
              await terminalPromise;
            }

            const rows = extractRows(
              await executeRawSql(
                capture.runtime,
                `SELECT id, status, end_time, duration_ms,
                        llm_call_count, provider_access_count
                 FROM trajectories WHERE agent_id = '${agentId}'`,
              ),
            ).map((row) => asRecord(row));
            expect(rows, scenario).toHaveLength(1);
            expect(rows[0], scenario).toMatchObject({
              id: trajectoryId,
              status: "completed",
              llm_call_count:
                ordering === "capture-first" && captureType === "llm" ? 1 : 0,
              provider_access_count:
                ordering === "capture-first" && captureType === "provider"
                  ? 1
                  : 0,
            });
            expect(Number.isFinite(Number(rows[0]?.end_time)), scenario).toBe(
              true,
            );
            expect(
              Number.isFinite(Number(rows[0]?.duration_ms)),
              scenario,
            ).toBe(true);

            const persisted = await loadTrajectoryById(
              capture.runtime,
              trajectoryId,
            );
            expect(persisted?.status, scenario).toBe("completed");
            expect(persisted?.endTime, scenario).not.toBeNull();
            const child = persisted?.steps.find(
              (step) => step.stepId === childStepId,
            );
            expect(child, scenario).toBeDefined();
            expect(child?.llmCalls, scenario).toHaveLength(
              ordering === "capture-first" && captureType === "llm" ? 1 : 0,
            );
            expect(child?.providerAccesses, scenario).toHaveLength(
              ordering === "capture-first" && captureType === "provider"
                ? 1
                : 0,
            );
            expect(
              __getTrajectoryBridgeStateCountsForTests(capture.runtime),
              scenario,
            ).toEqual({ stepMappings: 0, activeOwners: 0 });
            expect(
              __getTrajectoryBridgeStateCountsForTests(terminal.runtime),
              scenario,
            ).toEqual({ stepMappings: 0, activeOwners: 0 });

            const lateReports = (
              capture.runtime.reportError as unknown as ReturnType<typeof vi.fn>
            ).mock.calls.filter(
              ([scope, , context]) =>
                scope === "TrajectoryStorage.lateCapture" &&
                asRecord(context)?.diagnosticOnly === true,
            );
            expect(lateReports, scenario).toHaveLength(
              ordering === "end-first" ? 1 : 0,
            );
          } finally {
            gated.gate.release();
            try {
              if (terminalPromise) await terminalPromise;
            } finally {
              await terminal.logger.stop();
              await capture.logger.stop();
              await creator.logger.stop();
            }
          }
        }
      }
    }
  });

  it("retries distinct cross-runtime captures against the fresh active owner", async () => {
    const capturePairs = [
      { name: "llm-llm", first: "llm", second: "llm" },
      { name: "provider-provider", first: "provider", second: "provider" },
      { name: "llm-provider", first: "llm", second: "provider" },
    ] as const;

    for (const mode of ["public", "installed"] as const) {
      for (const pair of capturePairs) {
        const scenario = `${mode}/${pair.name}`;
        const agentId = crypto.randomUUID();
        const creator = await databaseLogger(mode, agentId);
        const gated = transactionGatedRuntime(agentId);
        const first = await databaseLogger(mode, agentId, gated.runtime);
        const second = await databaseLogger(
          mode,
          agentId,
          sharedDatabaseRuntime(agentId),
        );
        try {
          const trajectoryId = await creator.logger.startTrajectory(
            crypto.randomUUID(),
            { agentId, source: `active-race-${scenario}` },
          );
          const childStepId = creator.logger.startStep(trajectoryId);
          await flushTrajectoryWrites(creator.runtime, trajectoryId);

          gated.gate.arm();
          recordLoggerCapture(
            first.logger,
            pair.first,
            childStepId,
            `active-race-${scenario}-first`,
          );
          await gated.gate.entered;
          try {
            recordLoggerCapture(
              second.logger,
              pair.second,
              childStepId,
              `active-race-${scenario}-second`,
            );
            await flushTrajectoryWrites(second.runtime);
          } finally {
            gated.gate.release();
          }
          await flushTrajectoryWrites(first.runtime);

          const active = await loadTrajectoryById(first.runtime, trajectoryId);
          expect(active?.status, scenario).toBe("active");
          const activeChild = active?.steps.find(
            (step) => step.stepId === childStepId,
          );
          expect(activeChild, scenario).toBeDefined();
          const expectedLlmModels = [
            ...(pair.first === "llm" ? [`active-race-${scenario}-first`] : []),
            ...(pair.second === "llm"
              ? [`active-race-${scenario}-second`]
              : []),
          ].sort();
          const expectedProviderNames = [
            ...(pair.first === "provider"
              ? [`active-race-${scenario}-first`]
              : []),
            ...(pair.second === "provider"
              ? [`active-race-${scenario}-second`]
              : []),
          ].sort();
          expect(
            activeChild?.llmCalls.map((call) => call.model).sort(),
            scenario,
          ).toEqual(expectedLlmModels);
          expect(
            activeChild?.providerAccesses
              .map((access) => access.providerName)
              .sort(),
            scenario,
          ).toEqual(expectedProviderNames);
          const captureIds = [
            ...(activeChild?.llmCalls.map((call) => call.callId) ?? []),
            ...(activeChild?.providerAccesses.map(
              (access) => access.providerId,
            ) ?? []),
          ];
          const validCaptureIds = captureIds.filter(
            (id): id is string => typeof id === "string" && id.length > 0,
          );
          expect(captureIds, scenario).toHaveLength(2);
          expect(validCaptureIds, scenario).toHaveLength(captureIds.length);
          expect(new Set(validCaptureIds).size, scenario).toBe(2);

          const rows = extractRows(
            await executeRawSql(
              first.runtime,
              `SELECT id, status, llm_call_count, provider_access_count
               FROM trajectories WHERE agent_id = '${agentId}'`,
            ),
          ).map((row) => asRecord(row));
          expect(rows, scenario).toEqual([
            expect.objectContaining({
              id: trajectoryId,
              status: "active",
              llm_call_count: expectedLlmModels.length,
              provider_access_count: expectedProviderNames.length,
            }),
          ]);
          expect(
            first.runtime.reportError as unknown as ReturnType<typeof vi.fn>,
            scenario,
          ).not.toHaveBeenCalled();
          expect(
            second.runtime.reportError as unknown as ReturnType<typeof vi.fn>,
            scenario,
          ).not.toHaveBeenCalled();

          await creator.logger.endTrajectory(trajectoryId, "completed");
          const completed = await loadTrajectoryById(
            creator.runtime,
            trajectoryId,
          );
          expect(completed?.status, scenario).toBe("completed");
          expect(
            completed?.steps
              .find((step) => step.stepId === childStepId)
              ?.llmCalls.map((call) => call.model)
              .sort(),
            scenario,
          ).toEqual(expectedLlmModels);
          expect(
            completed?.steps
              .find((step) => step.stepId === childStepId)
              ?.providerAccesses.map((access) => access.providerName)
              .sort(),
            scenario,
          ).toEqual(expectedProviderNames);
          expect(
            __getTrajectoryBridgeStateCountsForTests(creator.runtime),
            scenario,
          ).toEqual({ stepMappings: 0, activeOwners: 0 });
        } finally {
          gated.gate.release();
          await second.logger.stop();
          await first.logger.stop();
          await creator.logger.stop();
        }
      }
    }
  });

  it("never recreates a parent deleted between capture load and write", async () => {
    for (const mode of ["public", "installed"] as const) {
      for (const captureType of ["llm", "provider"] as const) {
        const scenario = `${mode}/${captureType}`;
        const agentId = crypto.randomUUID();
        const creator = await databaseLogger(mode, agentId);
        const gated = transactionGatedRuntime(agentId);
        const capture = await databaseLogger(mode, agentId, gated.runtime);
        try {
          const trajectoryId = await creator.logger.startTrajectory(
            crypto.randomUUID(),
            { agentId, source: `delete-race-${scenario}` },
          );
          const childStepId = creator.logger.startStep(trajectoryId);
          await flushTrajectoryWrites(creator.runtime, trajectoryId);

          gated.gate.arm();
          recordLoggerCapture(
            capture.logger,
            captureType,
            childStepId,
            `delete-race-${scenario}`,
          );
          await gated.gate.entered;
          try {
            await executeRawSql(
              creator.runtime,
              `DELETE FROM trajectories WHERE id = '${trajectoryId}'`,
            );
          } finally {
            gated.gate.release();
          }
          await expect(
            flushTrajectoryWrites(capture.runtime),
          ).rejects.toMatchObject({ code: "TRAJECTORY_PARENT_NOT_FOUND" });
          capture.logger.setEnabled?.(false);

          expect(
            extractRows(
              await executeRawSql(
                capture.runtime,
                `SELECT id FROM trajectories WHERE agent_id = '${agentId}'`,
              ),
            ),
            scenario,
          ).toEqual([]);
          expect(
            extractRows(
              await executeRawSql(
                capture.runtime,
                `SELECT id FROM trajectory_steps
                 WHERE trajectory_id = '${trajectoryId}'`,
              ),
            ),
            scenario,
          ).toEqual([]);
          expect(
            (
              capture.runtime.reportError as unknown as ReturnType<typeof vi.fn>
            ).mock.calls.some(
              ([scope, error, context]) =>
                scope === "TrajectoryStorage.write" &&
                asRecord(error)?.code === "TRAJECTORY_PARENT_NOT_FOUND" &&
                asRecord(context)?.diagnosticOnly === true,
            ),
            scenario,
          ).toBe(true);
        } finally {
          gated.gate.release();
          capture.logger.setEnabled?.(false);
          await creator.logger.stop();
        }
      }
    }
  });

  it("rejects raw-child capture until child ownership is durable", async () => {
    for (const mode of ["public", "installed"] as const) {
      for (const captureType of ["llm", "provider"] as const) {
        const scenario = `${mode}/${captureType}`;
        const agentId = crypto.randomUUID();
        const gated = transactionGatedRuntime(agentId);
        const creator = await databaseLogger(mode, agentId, gated.runtime);
        const capture = await databaseLogger(
          mode,
          agentId,
          sharedDatabaseRuntime(agentId),
        );
        try {
          const trajectoryId = await creator.logger.startTrajectory(
            crypto.randomUUID(),
            { agentId, source: `raw-child-${scenario}` },
          );
          await flushTrajectoryWrites(creator.runtime, trajectoryId);

          gated.gate.arm();
          const childStepId = creator.logger.startStep(trajectoryId);
          await gated.gate.entered;
          recordLoggerCapture(
            capture.logger,
            captureType,
            childStepId,
            `raw-child-${scenario}`,
          );
          await expect(
            flushTrajectoryWrites(capture.runtime),
          ).rejects.toMatchObject({ code: "TRAJECTORY_PARENT_NOT_FOUND" });
          capture.logger.setEnabled?.(false);

          const rowsBeforeOwnership = extractRows(
            await executeRawSql(
              capture.runtime,
              `SELECT id, status FROM trajectories
               WHERE agent_id = '${agentId}' ORDER BY id`,
            ),
          ).map((row) => asRecord(row));
          expect(rowsBeforeOwnership, scenario).toEqual([
            expect.objectContaining({ id: trajectoryId, status: "active" }),
          ]);
          expect(
            rowsBeforeOwnership.some((row) => row?.id === childStepId),
            scenario,
          ).toBe(false);

          gated.gate.release();
          await flushTrajectoryWrites(creator.runtime, trajectoryId);
          const persisted = await loadTrajectoryById(
            creator.runtime,
            trajectoryId,
          );
          const child = persisted?.steps.find(
            (step) => step.stepId === childStepId,
          );
          expect(child, scenario).toBeDefined();
          expect(child?.llmCalls, scenario).toEqual([]);
          expect(child?.providerAccesses, scenario).toEqual([]);
          expect(
            extractRows(
              await executeRawSql(
                creator.runtime,
                `SELECT id FROM trajectories WHERE id = '${childStepId}'`,
              ),
            ),
            scenario,
          ).toEqual([]);

          await creator.logger.endTrajectory(trajectoryId, "completed");
          expect(
            __getTrajectoryBridgeStateCountsForTests(creator.runtime),
            scenario,
          ).toEqual({ stepMappings: 0, activeOwners: 0 });
        } finally {
          gated.gate.release();
          capture.logger.setEnabled?.(false);
          await creator.logger.stop();
        }
      }
    }
  });

  it("rejects malformed parent and dedicated rows across list, detail, and native export", async () => {
    const logger = runtime.getService("trajectories") as unknown as TrajLogger;
    const trajectoryId = crypto.randomUUID();
    const trajectory = createBaseTrajectory(
      trajectoryId,
      Date.now(),
      runtime.agentId,
      "malformed-test",
    );
    await saveTrajectory(runtime, trajectory);
    await executeRawSql(
      runtime,
      `UPDATE trajectories SET status = 'not-a-status' WHERE id = '${trajectoryId}'`,
    );
    await expect(
      logger.listTrajectories({ limit: 500, offset: 0 }),
    ).rejects.toThrow();
    await expect(logger.getTrajectoryDetail(trajectoryId)).rejects.toThrow();
    await expect(
      logger.exportTrajectories({
        format: "jsonl",
        trajectoryIds: [trajectoryId],
      }),
    ).rejects.toThrow();

    await executeRawSql(
      runtime,
      `UPDATE trajectories SET status = 'active', total_reward = 'NaN'
       WHERE id = '${trajectoryId}'`,
    );
    await expect(logger.getTrajectoryDetail(trajectoryId)).rejects.toThrow();
    await executeRawSql(
      runtime,
      `UPDATE trajectories SET total_reward = 0 WHERE id = '${trajectoryId}'`,
    );
    await executeRawSql(
      runtime,
      `UPDATE trajectory_steps SET payload = '{}' WHERE trajectory_id = '${trajectoryId}'`,
    );
    await expect(logger.getTrajectoryDetail(trajectoryId)).rejects.toThrow();
    await expect(
      logger.exportTrajectories({
        format: "jsonl",
        trajectoryIds: [trajectoryId],
      }),
    ).rejects.toThrow();
    await executeRawSql(
      runtime,
      `DELETE FROM trajectory_steps WHERE trajectory_id = '${trajectoryId}'`,
    );
    await executeRawSql(
      runtime,
      `DELETE FROM trajectories WHERE id = '${trajectoryId}'`,
    );
  });

  it("enforces ownership and cleanup on the unconstrained base trajectory_steps schema", async () => {
    const startedAt = Date.now();
    const trajectoryId = crypto.randomUUID();
    const parentStepId = crypto.randomUUID();
    const childStepId = crypto.randomUUID();
    const trajectory = createBaseTrajectory(
      trajectoryId,
      startedAt,
      runtime.agentId,
      "legacy-schema-test",
    );
    trajectory.steps[0] = {
      ...trajectory.steps[0],
      stepId: parentStepId,
      childSteps: [childStepId],
    };
    trajectory.steps.push({
      stepId: childStepId,
      parentStepId,
      stepNumber: 1,
      timestamp: startedAt + 1,
      llmCalls: [],
      providerAccesses: [],
      kind: "action",
      script: "return 'preserved';",
    });
    await saveTrajectory(runtime, trajectory);

    const rowsBefore = extractRows(
      await executeRawSql(
        runtime,
        `SELECT id, trajectory_id, ordinal, parent_step_id, step_type, name,
                started_at, ended_at, payload, script
         FROM trajectory_steps WHERE trajectory_id = '${trajectoryId}'
         ORDER BY ordinal`,
      ),
    ).map(asRecord);
    await executeRawSql(runtime, "DROP TABLE trajectory_steps");
    await executeRawSql(
      runtime,
      `CREATE TABLE trajectory_steps (
        id TEXT PRIMARY KEY,
        trajectory_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        parent_step_id TEXT,
        step_type TEXT NOT NULL DEFAULT 'llm',
        name TEXT,
        started_at BIGINT,
        ended_at BIGINT,
        payload TEXT NOT NULL DEFAULT '{}',
        script TEXT
      )`,
    );
    for (const row of rowsBefore) {
      const payload =
        typeof row?.payload === "string"
          ? row.payload
          : JSON.stringify(row?.payload);
      await executeRawSql(
        runtime,
        `INSERT INTO trajectory_steps (
          id, trajectory_id, ordinal, parent_step_id, step_type, name,
          started_at, ended_at, payload, script
        ) VALUES (
          '${String(row?.id)}', '${String(row?.trajectory_id)}',
          ${Number(row?.ordinal)},
          ${row?.parent_step_id ? `'${String(row.parent_step_id)}'` : "NULL"},
          '${String(row?.step_type)}',
          ${row?.name ? `'${String(row.name)}'` : "NULL"},
          ${Number(row?.started_at)}, ${Number(row?.ended_at)},
          '${payload.replaceAll("'", "''")}',
          ${row?.script ? `'${String(row.script).replaceAll("'", "''")}'` : "NULL"}
        )`,
      );
    }

    await executeRawSql(
      runtime,
      `DELETE FROM trajectory_schema_migrations
       WHERE id = 'trajectory_steps_constraints_v1'`,
    );

    const freshRuntime = sharedDatabaseRuntime(runtime.agentId);
    await expect(ensureTrajectoriesTable(freshRuntime)).resolves.toBe(true);
    const foreignKeyCount = Number(
      asRecord(
        extractRows(
          await executeRawSql(
            runtime,
            `SELECT count(*) AS total
             FROM pg_constraint
             WHERE conrelid = 'trajectory_steps'::regclass
               AND contype = 'f'`,
          ),
        )[0],
      )?.total,
    );
    expect(foreignKeyCount).toBe(2);
    const preserved = await loadTrajectoryById(freshRuntime, trajectoryId);
    expect(preserved?.steps).toHaveLength(2);
    expect(preserved?.steps[1]).toMatchObject({
      parentStepId,
      script: "return 'preserved';",
    });

    const migrationTrajectoryId = crypto.randomUUID();
    const migrationTrajectory = createBaseTrajectory(
      migrationTrajectoryId,
      startedAt + 2,
      runtime.agentId,
      "forward-migration-fault",
    );
    migrationTrajectory.steps.push({
      stepId: crypto.randomUUID(),
      parentStepId: migrationTrajectory.steps[0]?.stepId,
      stepNumber: 1,
      timestamp: startedAt + 3,
      llmCalls: [],
      providerAccesses: [],
    });
    migrationTrajectory.steps[0] = {
      ...migrationTrajectory.steps[0],
      childSteps: [migrationTrajectory.steps[1]?.stepId ?? "missing-child"],
    };
    await saveTrajectory(runtime, migrationTrajectory);
    await executeRawSql(
      runtime,
      `DELETE FROM trajectory_steps
       WHERE trajectory_id = '${migrationTrajectoryId}'`,
    );

    const migrationAdapter = (
      runtime as unknown as {
        adapter: {
          db: {
            execute: (query: unknown) => Promise<unknown>;
            transaction: <T>(
              callback: (tx: {
                execute: (query: unknown) => Promise<unknown>;
              }) => Promise<T>,
            ) => Promise<T>;
          };
        };
      }
    ).adapter;
    const migrationDb = migrationAdapter.db;
    let migrationInsertCount = 0;
    let failMigrationInsert = true;
    const faultMigrationRuntime = sharedDatabaseRuntime(runtime.agentId);
    (faultMigrationRuntime as unknown as { adapter: { db: unknown } }).adapter =
      {
        db: {
          execute: migrationDb.execute.bind(migrationDb),
          transaction: <T>(
            callback: (tx: {
              execute: (query: unknown) => Promise<unknown>;
            }) => Promise<T>,
          ): Promise<T> =>
            migrationDb.transaction((tx) =>
              callback({
                execute: async (query) => {
                  if (
                    /INSERT INTO trajectory_steps\s*\(/i.test(sqlText(query))
                  ) {
                    migrationInsertCount += 1;
                    if (failMigrationInsert && migrationInsertCount === 2) {
                      failMigrationInsert = false;
                      throw new Error("injected forward-migration failure");
                    }
                  }
                  return tx.execute(query);
                },
              }),
            ),
        },
      };
    await expect(ensureTrajectoriesTable(faultMigrationRuntime)).resolves.toBe(
      true,
    );
    expect(
      extractRows(
        await executeRawSql(
          runtime,
          `SELECT id FROM trajectory_steps
           WHERE trajectory_id = '${migrationTrajectoryId}'`,
        ),
      ),
    ).toEqual([]);
    expect(
      (await loadTrajectoryById(faultMigrationRuntime, migrationTrajectoryId))
        ?.steps,
    ).toHaveLength(2);
    await expect(ensureTrajectoriesTable(faultMigrationRuntime)).resolves.toBe(
      true,
    );
    expect(
      extractRows(
        await executeRawSql(
          runtime,
          `SELECT id FROM trajectory_steps
           WHERE trajectory_id = '${migrationTrajectoryId}'`,
        ),
      ),
    ).toHaveLength(2);

    const otherRuntime = sharedDatabaseRuntime(crypto.randomUUID());
    const otherTrajectoryId = crypto.randomUUID();
    await saveTrajectory(
      otherRuntime,
      createBaseTrajectory(
        otherTrajectoryId,
        startedAt + 10,
        otherRuntime.agentId,
        "legacy-schema-other",
      ),
    );
    await expect(
      upsertStep(otherRuntime, otherTrajectoryId, {
        stepId: childStepId,
        stepNumber: 1,
        timestamp: startedAt + 11,
        llmCalls: [],
        providerAccesses: [],
      }),
    ).rejects.toMatchObject({ code: "TRAJECTORY_STEP_OWNERSHIP_CONFLICT" });

    const logger = runtime.getService("trajectories") as unknown as TrajLogger;
    expect(await logger.deleteTrajectories([trajectoryId])).toBe(1);
    expect(
      extractRows(
        await executeRawSql(
          runtime,
          `SELECT id FROM trajectory_steps WHERE trajectory_id = '${trajectoryId}'`,
        ),
      ),
    ).toEqual([]);
  });
});
