/**
 * Trace-correlation spawn stamping + child-trajectory ingest (#13775). Drives
 * the service's real ingest against a temp state dir of trajectory JSON files
 * and asserts the env stamped onto a spawn carries the parent turn's traceId.
 * Uses the injectable InMemoryTaskStore (real store, no DB) and the real
 * trajectory-context; no mock stands in for the code under test.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveTrajectoryGate,
  runWithTrajectoryContext,
  TRACE_ENV,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The env-stamping suite exercises resolveTrajectoryGate/TRACE_ENV from
// @elizaos/core. In an isolated worktree the plugin resolves core's PREBUILT
// dist, which is stale until turbo rebuilds it (CI does this before plugin
// tests); guard so a stale-dist local run doesn't red. The ingest suite below
// has no such dependency and always runs.
const coreExportsPresent =
  typeof resolveTrajectoryGate === "function" && TRACE_ENV?.TRACE_ID != null;
const describeEnv = coreExportsPresent ? describe : describe.skip;

import { OrchestratorTaskService } from "../../src/services/orchestrator-task-service.js";
import { InMemoryTaskStore } from "../../src/services/orchestrator-task-store.js";
import type { OrchestratorTaskSession } from "../../src/services/orchestrator-task-types.js";

let stateDir: string;
const prevStateDir = process.env.ELIZA_STATE_DIR;
const prevLogging = process.env.ELIZA_TRAJECTORY_LOGGING;
const prevDisable = process.env.ELIZA_DISABLE_TRAJECTORY_LOGGING;

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

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "orch-trace-"));
  process.env.ELIZA_STATE_DIR = stateDir;
  delete process.env.ELIZA_DISABLE_TRAJECTORY_LOGGING;
});

afterEach(() => {
  if (prevStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = prevStateDir;
  if (prevLogging === undefined) delete process.env.ELIZA_TRAJECTORY_LOGGING;
  else process.env.ELIZA_TRAJECTORY_LOGGING = prevLogging;
  if (prevDisable === undefined)
    delete process.env.ELIZA_DISABLE_TRAJECTORY_LOGGING;
  else process.env.ELIZA_DISABLE_TRAJECTORY_LOGGING = prevDisable;
});

describeEnv("buildChildTraceEnv", () => {
  it("stamps the parent turn's traceId + parent step and enables logging when the gate is on", () => {
    process.env.ELIZA_TRAJECTORY_LOGGING = "1";
    expect(resolveTrajectoryGate().enabled).toBe(true);
    const svc = new OrchestratorTaskService(makeRuntime(), {
      store: new InMemoryTaskStore(),
    });
    const env = runWithTrajectoryContext(
      { traceId: "trace-parent", trajectoryStepId: "step-7" },
      () =>
        (
          svc as unknown as {
            buildChildTraceEnv: (t: string) => Record<string, string>;
          }
        ).buildChildTraceEnv("task-xyz"),
    ) as Record<string, string>;
    expect(env[TRACE_ENV.TRACE_ID]).toBe("trace-parent");
    expect(env[TRACE_ENV.TASK_ID]).toBe("task-xyz");
    expect(env[TRACE_ENV.PARENT_STEP_ID]).toBe("step-7");
    expect(env.ELIZA_TRAJECTORY_LOGGING).toBe("1");
    expect(env.ELIZA_TRAJECTORY_DIR).toContain(
      join("child-trajectories", "task-xyz"),
    );
  });

  it("forwards an explicit ELIZA_TRAJECTORY_LOGGING=0 when the gate is off", () => {
    process.env.ELIZA_DISABLE_TRAJECTORY_LOGGING = "1";
    expect(resolveTrajectoryGate().enabled).toBe(false);
    const svc = new OrchestratorTaskService(makeRuntime(), {
      store: new InMemoryTaskStore(),
    });
    const env = (
      svc as unknown as {
        buildChildTraceEnv: (t: string) => Record<string, string>;
      }
    ).buildChildTraceEnv("task-off");
    expect(env.ELIZA_TRAJECTORY_LOGGING).toBe("0");
    expect(env.ELIZA_TRAJECTORY_DIR).toBeUndefined();
    // A traceId is still minted so the child is joinable even with the gate off.
    expect(env[TRACE_ENV.TRACE_ID]).toBeTruthy();
  });
});

describe("ingestChildTrajectories", () => {
  it("attaches child trajectory files as artifacts + appends childTrajectoryIds", async () => {
    const store = new InMemoryTaskStore();
    const { taskId, sessionId } = await seedTaskWithSession(store, {
      traceId: "trace-parent",
      parentTrajectoryStepId: "step-7",
    });
    const svc = new OrchestratorTaskService(makeRuntime(), { store });

    // Two child trajectory files under the per-task dir, in an agentId subdir
    // exactly as the recorder writes them.
    const dir = join(
      stateDir,
      "orchestrator",
      "child-trajectories",
      taskId,
      "child-agent",
    );
    await mkdir(dir, { recursive: true });
    writeFileSync(
      join(dir, "tj-aaa.json"),
      JSON.stringify({ traceId: "trace-parent" }),
    );
    writeFileSync(
      join(dir, "tj-bbb.json"),
      JSON.stringify({ traceId: "trace-parent" }),
    );

    const ingested = await (
      svc as unknown as {
        ingestChildTrajectories: (t: string, s: string) => Promise<string[]>;
      }
    ).ingestChildTrajectories(taskId, sessionId);

    expect(ingested.sort()).toEqual(["tj-aaa", "tj-bbb"]);

    const doc = await store.getTask(taskId);
    const artifacts = doc?.artifacts ?? [];
    expect(artifacts.length).toBe(2);
    expect(artifacts.every((a) => a.artifactType === "trajectory")).toBe(true);
    const corr = artifacts[0].metadata.correlation as {
      traceId?: string;
      childTrajectoryId?: string;
    };
    expect(corr.traceId).toBe("trace-parent");
    expect(corr.childTrajectoryId).toBeTruthy();

    const updatedSession = (await store.findSession(sessionId))?.session;
    expect((updatedSession?.childTrajectoryIds ?? []).sort()).toEqual([
      "tj-aaa",
      "tj-bbb",
    ]);
  });

  it("treats a missing child-trajectory dir as an empty result, not an error", async () => {
    const store = new InMemoryTaskStore();
    const { taskId, sessionId } = await seedTaskWithSession(store, {});
    const svc = new OrchestratorTaskService(makeRuntime(), { store });
    // No dir written — non-eliza backend / gate-off child records nothing.
    const ingested = await (
      svc as unknown as {
        ingestChildTrajectories: (t: string, s: string) => Promise<string[]>;
      }
    ).ingestChildTrajectories(taskId, sessionId);
    expect(ingested).toEqual([]);
    const doc = await store.getTask(taskId);
    expect(doc?.artifacts ?? []).toEqual([]);
  });

  // #14110: the trajectory dir is per-task but ingest runs per session-
  // completion, so a re-completion or a respawned session used to re-attach
  // the same files. These regressions lock in idempotency.
  it("is idempotent across a re-completion of the same session (no duplicate artifacts or ids)", async () => {
    const store = new InMemoryTaskStore();
    const { taskId, sessionId } = await seedTaskWithSession(store, {
      traceId: "trace-parent",
      parentTrajectoryStepId: "step-7",
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
    writeFileSync(join(dir, "tj-aaa.json"), JSON.stringify({ t: 1 }));
    writeFileSync(join(dir, "tj-bbb.json"), JSON.stringify({ t: 1 }));

    const ingest = (
      svc as unknown as {
        ingestChildTrajectories: (t: string, s: string) => Promise<string[]>;
      }
    ).ingestChildTrajectories.bind(svc);

    const first = await ingest(taskId, sessionId);
    expect(first.sort()).toEqual(["tj-aaa", "tj-bbb"]);

    // Same session re-completes (follow-up prompt) → same files re-scanned.
    const second = await ingest(taskId, sessionId);
    expect(second).toEqual([]);

    const doc = await store.getTask(taskId);
    const artifacts = doc?.artifacts ?? [];
    // Still exactly two — no fresh-UUID duplicates.
    expect(artifacts.length).toBe(2);
    const ids = artifacts
      .map(
        (a) =>
          (a.metadata.correlation as { childTrajectoryId?: string })
            .childTrajectoryId,
      )
      .sort();
    expect(ids).toEqual(["tj-aaa", "tj-bbb"]);

    const session = (await store.findSession(sessionId))?.session;
    // No duplicate ids on the session record either.
    expect((session?.childTrajectoryIds ?? []).sort()).toEqual([
      "tj-aaa",
      "tj-bbb",
    ]);
  });

  it("does not re-ingest session A's files under a respawned session B, preserving A's correlation", async () => {
    const store = new InMemoryTaskStore();
    const { taskId, sessionId: sessionA } = await seedTaskWithSession(store, {
      traceId: "trace-A",
      parentTrajectoryStepId: "step-A",
    });
    // Respawned session B on the SAME task (different correlation).
    const sessionB = "sess-B";
    const now = new Date().toISOString();
    await store.addSession({
      id: "row-B",
      taskId,
      sessionId: sessionB,
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
      traceId: "trace-B",
      parentTrajectoryStepId: "step-B",
      metadata: {},
      createdAt: now,
      updatedAt: now,
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
    // These files were recorded by session A.
    writeFileSync(join(dir, "tj-aaa.json"), JSON.stringify({ t: 1 }));
    writeFileSync(join(dir, "tj-bbb.json"), JSON.stringify({ t: 1 }));

    const ingest = (
      svc as unknown as {
        ingestChildTrajectories: (t: string, s: string) => Promise<string[]>;
      }
    ).ingestChildTrajectories.bind(svc);

    // Session A completes first and attaches its files.
    await ingest(taskId, sessionA);
    // Session B (respawn) completes; must NOT re-attach A's files nor stamp B.
    const bIngested = await ingest(taskId, sessionB);
    expect(bIngested).toEqual([]);

    const doc = await store.getTask(taskId);
    const artifacts = doc?.artifacts ?? [];
    expect(artifacts.length).toBe(2);
    // Every trajectory still carries session A's correlation, not B's.
    for (const a of artifacts) {
      const corr = a.metadata.correlation as {
        sessionId?: string;
        traceId?: string;
        parentStepId?: string;
      };
      expect(corr.sessionId).toBe(sessionA);
      expect(corr.traceId).toBe("trace-A");
      expect(corr.parentStepId).toBe("step-A");
    }
    // B's session record never gained A's ids.
    const sessionBRec = (await store.findSession(sessionB))?.session;
    expect(sessionBRec?.childTrajectoryIds ?? []).toEqual([]);
  });

  it("only the new file is ingested when a second, distinct trajectory appears later", async () => {
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
    writeFileSync(join(dir, "tj-aaa.json"), JSON.stringify({ t: 1 }));

    const ingest = (
      svc as unknown as {
        ingestChildTrajectories: (t: string, s: string) => Promise<string[]>;
      }
    ).ingestChildTrajectories.bind(svc);

    expect(await ingest(taskId, sessionId)).toEqual(["tj-aaa"]);

    // A genuinely new trajectory shows up on a later completion.
    writeFileSync(join(dir, "tj-ccc.json"), JSON.stringify({ t: 1 }));
    expect(await ingest(taskId, sessionId)).toEqual(["tj-ccc"]);

    const doc = await store.getTask(taskId);
    expect((doc?.artifacts ?? []).length).toBe(2);
  });
});
