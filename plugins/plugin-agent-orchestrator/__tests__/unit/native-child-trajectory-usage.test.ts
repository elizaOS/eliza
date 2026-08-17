/**
 * Native Eliza Code does not currently return an ACP terminal usage frame.
 * Its finished, session-scoped trajectory is therefore the authoritative
 * fallback for the normal task/session usage surface. These regressions pin
 * that fallback and the path-containment boundary used to read it.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OrchestratorTaskService } from "../../src/services/orchestrator-task-service.js";
import { InMemoryTaskStore } from "../../src/services/orchestrator-task-store.js";
import type { OrchestratorTaskSession } from "../../src/services/orchestrator-task-types.js";

let stateDir: string;
const previousStateDir = process.env.ELIZA_STATE_DIR;

function makeRuntime() {
  return {
    agentId: "00000000-0000-4000-8000-000000000001",
    adapter: undefined,
    databaseAdapter: undefined,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    getSetting: () => undefined,
    getService: () => undefined,
    reportError: () => {},
  } as unknown as Parameters<typeof OrchestratorTaskService>[0];
}

async function seedNativeSession(
  store: InMemoryTaskStore,
): Promise<{ taskId: string; sessionId: string }> {
  const doc = await store.createTask({
    title: "native usage",
    goal: "measure the native child",
  });
  const taskId = doc.task.id;
  const sessionId = "native-session";
  const now = new Date().toISOString();
  const session: OrchestratorTaskSession = {
    id: "native-row",
    taskId,
    sessionId,
    framework: "elizaos",
    label: "Eliza Code",
    originalTask: "measure the native child",
    workdir: "/tmp/native-usage",
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
    traceId: "trace-native",
    metadata: {},
    createdAt: now,
    updatedAt: now,
  };
  await store.addSession(session);
  return { taskId, sessionId };
}

function finishedNativeTrajectory(taskId: string, sessionId: string): object {
  const usage = {
    promptTokens: 156_875,
    completionTokens: 3_742,
    cacheReadInputTokens: 133_632,
    cacheCreationInputTokens: 0,
    reasoningTokens: 7,
    totalTokens: 160_617,
  };
  return {
    trajectoryId: "tj-native",
    agentId: "child-agent",
    taskId,
    sessionId,
    traceId: "trace-native",
    rootMessage: { id: "root-message", text: "implement the task" },
    startedAt: 1,
    endedAt: 2,
    status: "finished",
    stages: [
      {
        stageId: "planner-1",
        kind: "planner",
        startedAt: 1,
        endedAt: 2,
        latencyMs: 1,
        model: {
          modelType: "TEXT_LARGE",
          modelName: "gpt-oss-120b",
          provider: "cerebras",
          response: "done",
          usage,
          costUsd: 0.05771275,
        },
      },
      {
        stageId: "file-write-1",
        kind: "tool",
        startedAt: 1,
        endedAt: 1,
        latencyMs: 0,
        tool: {
          name: "FILE",
          args: {
            action: "write",
            target: "workspace",
            file_path: "/tmp/native-usage/src/stats.mjs",
          },
          success: true,
        },
      },
      {
        stageId: "file-write-failed",
        kind: "tool",
        startedAt: 1,
        endedAt: 1,
        latencyMs: 0,
        tool: {
          name: "FILE",
          args: {
            action: "write",
            target: "workspace",
            file_path: "/tmp/native-usage/failed.tmp",
          },
          success: false,
        },
      },
      {
        stageId: "file-write-2",
        kind: "tool",
        startedAt: 1,
        endedAt: 1,
        latencyMs: 0,
        tool: {
          name: "FILE",
          args: {
            action: "write",
            target: "workspace",
            file_path: "/tmp/native-usage/test/stats.test.mjs",
          },
          success: true,
        },
      },
    ],
    metrics: {
      totalLatencyMs: 1,
      totalPromptTokens: 156_875,
      totalCompletionTokens: 3_742,
      totalCacheReadTokens: 133_632,
      totalCacheCreationTokens: 0,
      totalReasoningTokens: 7,
      totalCostUsd: 0.05771275,
      plannerIterations: 1,
      toolCallsExecuted: 3,
      toolCallFailures: 1,
      toolSearchCount: 0,
      evaluatorFailures: 0,
      finalDecision: "FINISH",
    },
  };
}

async function ingest(
  service: OrchestratorTaskService,
  taskId: string,
  sessionId: string,
): Promise<string[]> {
  return (
    service as unknown as {
      ingestChildTrajectories: (
        task: string,
        session: string,
      ) => Promise<string[]>;
    }
  ).ingestChildTrajectories(taskId, sessionId);
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "orchestrator-native-usage-"));
  process.env.ELIZA_STATE_DIR = stateDir;
});

afterEach(() => {
  if (previousStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
  else process.env.ELIZA_STATE_DIR = previousStateDir;
  rmSync(stateDir, { recursive: true, force: true });
});

describe("native child trajectory usage", () => {
  it("mirrors a finished native trajectory into task and session usage", async () => {
    const store = new InMemoryTaskStore();
    const { taskId, sessionId } = await seedNativeSession(store);
    const service = new OrchestratorTaskService(makeRuntime(), { store });
    const dir = join(
      stateDir,
      "orchestrator",
      "child-trajectories",
      taskId,
      "child-agent",
    );
    await mkdir(dir, { recursive: true });
    const trajectoryPath = join(dir, "tj-native.json");
    writeFileSync(
      trajectoryPath,
      JSON.stringify(finishedNativeTrajectory(taskId, sessionId)),
    );

    expect(await ingest(service, taskId, sessionId)).toEqual(["tj-native"]);

    const usage = await service.getUsage(taskId);
    expect(usage).toMatchObject({
      state: "measured",
      inputTokens: 156_875,
      outputTokens: 3_742,
      reasoningTokens: 7,
      cacheTokens: 133_632,
      totalTokens: 160_624,
      costUsd: 0.05771275,
      byProvider: [
        {
          provider: "cerebras",
          model: "gpt-oss-120b",
          state: "measured",
          inputTokens: 156_875,
          outputTokens: 3_742,
          reasoningTokens: 7,
          cacheTokens: 133_632,
          totalTokens: 160_624,
          costUsd: 0.05771275,
        },
      ],
    });

    const detail = await service.getTask(taskId);
    expect(detail?.sessions[0]).toMatchObject({
      sessionId,
      usageState: "measured",
      inputTokens: 156_875,
      outputTokens: 3_742,
      reasoningTokens: 7,
      cacheTokens: 133_632,
      totalTokens: 160_624,
      costUsd: 0.05771275,
      metadata: {
        lastChangeSet: {
          changedFiles: ["src/stats.mjs", "test/stats.test.mjs"],
        },
      },
    });

    const persisted = await store.getTask(taskId);
    const artifactMetadata = persisted?.artifacts[0]?.metadata;
    expect(artifactMetadata).toMatchObject({
      childTrajectoryUsageV1: {
        changedFiles: ["src/stats.mjs", "test/stats.test.mjs"],
      },
    });
    expect(JSON.stringify(artifactMetadata)).not.toContain(
      "implement the task",
    );
    expect(JSON.stringify(artifactMetadata)).not.toContain('"response":"done"');

    // Trace accounting remains available from the sanitized durable summary
    // even after the attach-by-reference source file is reclaimed.
    rmSync(trajectoryPath, { force: true });
    expect(await service.getTraceUsage(taskId)).toMatchObject({
      readState: "complete",
      artifactCount: 1,
      readableArtifactCount: 1,
      unreadableArtifactCount: 0,
      promptTokens: 156_875,
      completionTokens: 3_742,
      reasoningTokens: 7,
      cacheReadTokens: 133_632,
      costUsd: 0.05771275,
    });

    // Re-ingesting a replayed completion must not double-count the same file.
    writeFileSync(
      trajectoryPath,
      JSON.stringify(finishedNativeTrajectory(taskId, sessionId)),
    );
    expect(await ingest(service, taskId, sessionId)).toEqual([]);
    expect((await service.getUsage(taskId))?.totalTokens).toBe(160_624);
  });

  it("waits for the recorder's final flush instead of deduping a running snapshot forever", async () => {
    const store = new InMemoryTaskStore();
    const { taskId, sessionId } = await seedNativeSession(store);
    const service = new OrchestratorTaskService(makeRuntime(), { store });
    const dir = join(
      stateDir,
      "orchestrator",
      "child-trajectories",
      taskId,
      "child-agent",
    );
    await mkdir(dir, { recursive: true });
    const path = join(dir, "tj-native.json");
    writeFileSync(
      path,
      JSON.stringify({
        ...finishedNativeTrajectory(taskId, sessionId),
        status: "running",
      }),
    );
    const finalFlush = setTimeout(() => {
      writeFileSync(
        path,
        JSON.stringify(finishedNativeTrajectory(taskId, sessionId)),
      );
    }, 40);

    try {
      expect(await ingest(service, taskId, sessionId)).toEqual(["tj-native"]);
    } finally {
      clearTimeout(finalFlush);
    }
    expect(await service.getUsage(taskId)).toMatchObject({
      state: "measured",
      inputTokens: 156_875,
      outputTokens: 3_742,
      costUsd: 0.05771275,
    });
    expect(
      (await store.getTask(taskId))?.artifacts[0]?.metadata,
    ).toHaveProperty("childTrajectoryUsageV1");
  });

  it("keeps ACP-origin usage authoritative when the adapter reports it", async () => {
    const store = new InMemoryTaskStore();
    const { taskId, sessionId } = await seedNativeSession(store);
    const service = new OrchestratorTaskService(makeRuntime(), { store });
    await store.addUsage({
      id: "acp-usage",
      taskId,
      sessionId,
      provider: "cerebras",
      model: "gpt-oss-120b",
      inputTokens: 10,
      outputTokens: 2,
      reasoningTokens: 0,
      cacheTokens: 3,
      costUsd: 0.001,
      state: "measured",
      sourceEventId: "acp:turn-1",
      timestamp: Date.now(),
      createdAt: new Date().toISOString(),
    });
    const dir = join(
      stateDir,
      "orchestrator",
      "child-trajectories",
      taskId,
      "child-agent",
    );
    await mkdir(dir, { recursive: true });
    writeFileSync(
      join(dir, "tj-native.json"),
      JSON.stringify(finishedNativeTrajectory(taskId, sessionId)),
    );

    expect(await ingest(service, taskId, sessionId)).toEqual(["tj-native"]);
    const stored = await store.getTask(taskId);
    expect(stored?.usage).toHaveLength(1);
    expect(await service.getUsage(taskId)).toMatchObject({
      inputTokens: 10,
      outputTokens: 2,
      cacheTokens: 3,
      costUsd: 0.001,
    });
    // The separate trace surface still exposes the child model-call evidence.
    expect(await service.getTraceUsage(taskId)).toMatchObject({
      promptTokens: 156_875,
      completionTokens: 3_742,
      costUsd: 0.05771275,
    });
  });

  it("safe-reads a controlled legacy artifact without persisted usage metadata", async () => {
    const store = new InMemoryTaskStore();
    const { taskId, sessionId } = await seedNativeSession(store);
    const service = new OrchestratorTaskService(makeRuntime(), { store });
    const dir = join(
      stateDir,
      "orchestrator",
      "child-trajectories",
      taskId,
      "child-agent",
    );
    await mkdir(dir, { recursive: true });
    const path = join(dir, "tj-native.json");
    writeFileSync(
      path,
      JSON.stringify(finishedNativeTrajectory(taskId, sessionId)),
    );
    await store.addArtifact({
      id: "legacy-artifact",
      taskId,
      sessionId,
      artifactType: "trajectory",
      title: "legacy trajectory",
      path,
      verificationStatus: "pending",
      metadata: {},
      createdAt: new Date().toISOString(),
    });

    expect(await service.getTraceUsage(taskId)).toMatchObject({
      readState: "complete",
      artifactCount: 1,
      readableArtifactCount: 1,
      promptTokens: 156_875,
      completionTokens: 3_742,
      costUsd: 0.05771275,
    });
  });

  it("does not follow a trajectory artifact path outside the controlled child directory", async () => {
    const store = new InMemoryTaskStore();
    const { taskId, sessionId } = await seedNativeSession(store);
    const service = new OrchestratorTaskService(makeRuntime(), { store });
    const externalDir = mkdtempSync(join(tmpdir(), "untrusted-trajectory-"));
    const externalPath = join(externalDir, "tj-untrusted.json");
    writeFileSync(
      externalPath,
      JSON.stringify(finishedNativeTrajectory(taskId, sessionId)),
    );
    await store.addArtifact({
      id: "untrusted-artifact",
      taskId,
      sessionId,
      artifactType: "trajectory",
      title: "untrusted path",
      path: externalPath,
      verificationStatus: "pending",
      metadata: {},
      createdAt: new Date().toISOString(),
    });

    try {
      const traceUsage = await service.getTraceUsage(taskId);
      expect(traceUsage).toMatchObject({
        readState: "partial",
        artifactCount: 1,
        readableArtifactCount: 0,
        unreadableArtifactCount: 1,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: 0,
        artifactErrors: [
          {
            path: externalPath,
            reason: "untrusted_path",
          },
        ],
      });
    } finally {
      rmSync(externalDir, { recursive: true, force: true });
    }
  });
});
