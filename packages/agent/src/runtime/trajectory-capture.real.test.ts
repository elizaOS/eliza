/**
 * End-to-end trajectory capture verification.
 *
 * Reproduces + guards the bug where the in-memory "trajectories" service
 * captured LLM calls only into its own `trajectory_step_index` store, while the
 * viewer + collection read the SQL `trajectory_steps` tables — so on every
 * platform without the plugin-training log-backfill (mobile, cloud) a trajectory
 * showed ZERO recorded LLM calls.
 *
 * `installDatabaseTrajectoryLogger(runtime)` is the bridge that mirrors capture
 * into `trajectory_steps`; it is now wired at boot in
 * `prepareRuntimeForTrajectoryCapture`. This test boots a real PGLite-backed
 * runtime, installs the bridge, drives the exact `logLlmCall` capture primitive
 * the runtime's `recordUseModelTrajectory` uses for BOTH a local-inference and a
 * cloud provider, then reads back through the viewer's SQL read API and asserts
 * both calls are persisted.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Plugin } from "@elizaos/core";
import { AgentRuntime } from "@elizaos/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { installDatabaseTrajectoryLogger } from "./trajectory-persistence.ts";
import { flushTrajectoryWrites } from "./trajectory-storage.ts";

interface CapturedLlmCall {
  provider?: string;
  model?: string;
}
interface TrajectoryDetailLike {
  steps?: Array<{ llmCalls?: CapturedLlmCall[] }>;
}
interface TrajLogger {
  startTrajectory: (
    agentId: string,
    opts?: { source?: string; metadata?: Record<string, unknown> },
  ) => Promise<string>;
  startStep: (trajectoryId: string) => string;
  logLlmCall: (params: Record<string, unknown>) => void;
  listTrajectories: (opts?: { limit?: number; offset?: number }) => Promise<{
    trajectories: Array<{ id: string; llmCallCount: number }>;
    total: number;
  }>;
  getTrajectoryDetail: (id: string) => Promise<TrajectoryDetailLike | null>;
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
  it("persists LOCAL and CLOUD LLM calls into the trajectory_steps store the viewer reads", async () => {
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

    // The exact capture primitive runtime.recordUseModelTrajectory invokes,
    // for a local-inference provider AND a cloud provider.
    logger.logLlmCall(
      llmCall(stepId, "local-inference", "eliza-1-2b", "hello from local"),
    );
    logger.logLlmCall(llmCall(stepId, "openai", "gpt-5.5", "hello from cloud"));

    // Flush the async step-write queue the bridge enqueues.
    await flushTrajectoryWrites(runtime);

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
    const calls = (detail?.steps ?? []).flatMap((s) => s.llmCalls ?? []);
    const providers = new Set(
      calls.map((c) => c.provider).filter((p): p is string => Boolean(p)),
    );
    expect(providers.has("local-inference"), "local call persisted").toBe(true);
    expect(providers.has("openai"), "cloud call persisted").toBe(true);
  });
});
