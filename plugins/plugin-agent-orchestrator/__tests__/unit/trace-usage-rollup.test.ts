/**
 * Per-task trace usage roll-up (#13775 item 5). Drives the service's real
 * getTraceUsage against on-disk child-trajectory files ingested as artifacts,
 * asserting it sums the file-recorder metrics grouped by traceId — separate
 * from the ACP-frame getUsage surface — and degrades on an unreadable/corrupt
 * file instead of throwing. Uses the injectable InMemoryTaskStore (real store)
 * and the real ingest path; no mock stands in for the code under test.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as core from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// getTraceUsage delegates to core's rollUpTrajectoryUsage. In an isolated
// worktree the plugin resolves core's PREBUILT dist, which is stale until
// turbo rebuilds it (CI does this before plugin tests); a namespace import
// yields `undefined` for a not-yet-built export rather than a load error, so
// guard on it and skip a stale-dist local run instead of red-ing. Same
// stale-dist guard rationale as child-trajectory-ingest.test.ts.
const describeCore =
  typeof (core as { rollUpTrajectoryUsage?: unknown }).rollUpTrajectoryUsage ===
  "function"
    ? describe
    : describe.skip;

import { OrchestratorTaskService } from "../../src/services/orchestrator-task-service.js";
import { InMemoryTaskStore } from "../../src/services/orchestrator-task-store.js";
import type { OrchestratorTaskSession } from "../../src/services/orchestrator-task-types.js";

let stateDir: string;
const prevStateDir = process.env.ELIZA_STATE_DIR;

function makeRuntime() {
  return {
    agentId: "00000000-0000-4000-8000-000000000001",
    adapter: undefined,
    databaseAdapter: undefined,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    getSetting: () => undefined,
    reportError: () => {},
  } as unknown as Parameters<typeof OrchestratorTaskService>[0];
}

async function seedTaskWithSession(
  store: InMemoryTaskStore,
  session: Partial<OrchestratorTaskSession>,
): Promise<{ taskId: string; sessionId: string }> {
  const doc = await store.createTask({ title: "t", goal: "do the thing" });
  const taskId = doc.task.id;
  const sessionId = "sess-1";
  const now = new Date().toISOString();
  await store.addSession({
    id: "row-1",
    taskId,
    sessionId,
    framework: "elizaos",
    label: "worker",
    originalTask: "do the thing",
    workdir: "/tmp/wd",
    status: "completed",
    decisionCount: 0,
    autoResolvedCount: 0,
    registeredAt: Date.now(),
    lastActivityAt: Date.now(),
    idleCheckCount: 0,
    taskDelivered: true,
    lastSeenDecisionIndex: 0,
    spawnedAt: Date.now(),
    retryCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheTokens: 0,
    costUsd: 0,
    usageState: "unavailable",
    metadata: {},
    createdAt: now,
    updatedAt: now,
    ...session,
  });
  return { taskId, sessionId };
}

function trajectoryJson(traceId: string, prompt: number, cost: number): string {
  return JSON.stringify({
    trajectoryId: `tj-${prompt}`,
    agentId: "child-agent",
    traceId,
    rootMessage: { id: "m", text: "hi" },
    startedAt: 0,
    status: "finished",
    stages: [],
    metrics: {
      totalLatencyMs: 0,
      totalPromptTokens: prompt,
      totalCompletionTokens: Math.floor(prompt / 5),
      totalCacheReadTokens: 0,
      totalCacheCreationTokens: 0,
      totalCostUsd: cost,
      plannerIterations: 0,
      toolCallsExecuted: 0,
      toolCallFailures: 0,
      toolSearchCount: 0,
      evaluatorFailures: 0,
    },
  });
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "orch-trace-usage-"));
  process.env.ELIZA_STATE_DIR = stateDir;
});

afterEach(() => {
  if (prevStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = prevStateDir;
});

async function ingest(
  svc: OrchestratorTaskService,
  taskId: string,
  sessionId: string,
): Promise<string[]> {
  return (
    svc as unknown as {
      ingestChildTrajectories: (t: string, s: string) => Promise<string[]>;
    }
  ).ingestChildTrajectories(taskId, sessionId);
}

describeCore("getTraceUsage", () => {
  it("sums the ingested child-trajectory metrics grouped by traceId", async () => {
    const store = new InMemoryTaskStore();
    const { taskId, sessionId } = await seedTaskWithSession(store, {
      traceId: "trace-parent",
    });
    const svc = new OrchestratorTaskService(makeRuntime(), { store });

    const dir = join(
      stateDir,
      "orchestrator",
      "child-trajectories",
      taskId,
      "child-agent",
    );
    await mkdir(dir, { recursive: true });
    writeFileSync(join(dir, "tj-100.json"), trajectoryJson("trace-parent", 100, 0.01));
    writeFileSync(join(dir, "tj-50.json"), trajectoryJson("trace-parent", 50, 0.005));

    await ingest(svc, taskId, sessionId);
    const rollup = await svc.getTraceUsage(taskId);
    expect(rollup).not.toBeNull();
    expect(rollup?.byTrace).toHaveLength(1);
    expect(rollup?.byTrace[0].traceId).toBe("trace-parent");
    expect(rollup?.promptTokens).toBe(150);
    // completion = floor(100/5) + floor(50/5) = 20 + 10 = 30
    expect(rollup?.completionTokens).toBe(30);
    expect(rollup?.totalTokens).toBe(180);
    expect(rollup?.trajectoryCount).toBe(2);
    expect(rollup?.costUsd).toBeCloseTo(0.015, 6);
  });

  it("skips a corrupt trajectory artifact instead of throwing, still summing the readable ones", async () => {
    const store = new InMemoryTaskStore();
    const { taskId, sessionId } = await seedTaskWithSession(store, {
      traceId: "trace-parent",
    });
    const svc = new OrchestratorTaskService(makeRuntime(), { store });

    const dir = join(
      stateDir,
      "orchestrator",
      "child-trajectories",
      taskId,
      "child-agent",
    );
    await mkdir(dir, { recursive: true });
    writeFileSync(join(dir, "tj-good.json"), trajectoryJson("trace-parent", 40, 0.004));
    writeFileSync(join(dir, "tj-bad.json"), "{ this is not valid json");

    await ingest(svc, taskId, sessionId);
    const rollup = await svc.getTraceUsage(taskId);
    expect(rollup?.promptTokens).toBe(40);
    expect(rollup?.trajectoryCount).toBe(1);
    expect(rollup?.costUsd).toBeCloseTo(0.004, 6);
  });

  it("returns an empty roll-up (not null) for a task with no trajectory artifacts", async () => {
    const store = new InMemoryTaskStore();
    const { taskId } = await seedTaskWithSession(store, {});
    const svc = new OrchestratorTaskService(makeRuntime(), { store });
    const rollup = await svc.getTraceUsage(taskId);
    expect(rollup).not.toBeNull();
    expect(rollup?.byTrace).toEqual([]);
    expect(rollup?.totalTokens).toBe(0);
    expect(rollup?.trajectoryCount).toBe(0);
  });

  it("returns null for an unknown task", async () => {
    const store = new InMemoryTaskStore();
    const svc = new OrchestratorTaskService(makeRuntime(), { store });
    expect(await svc.getTraceUsage("nope")).toBeNull();
  });
});
