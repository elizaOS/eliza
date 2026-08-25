/**
 * Unit coverage for trajectory-storage write operations: public start, annotate,
 * complete, delete, clear, flush, and prune boundaries; DatabaseTrajectoryLogger
 * enablement, empty-queue, missing-item, and invalid-settlement paths; and the
 * diagnostic projectors. A stub adapter records SQL — the real module is under
 * test, not a mock of itself.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { TrajectoryActionAttempt } from "../types/trajectory.ts";
import {
  __getTrajectoryBridgeStateCountsForTests,
  annotateTrajectoryStep,
  clearPersistedTrajectoryRows,
  completeTrajectoryStepInDatabase,
  createDatabaseTrajectoryLogger,
  DatabaseTrajectoryLogger,
  deletePersistedTrajectoryRows,
  flushTrajectoryWrites,
  installDatabaseTrajectoryLogger,
  projectLlmCallDiagnostics,
  projectSettledActionDiagnostics,
  pruneOldTrajectories,
  startTrajectoryStepInDatabase,
} from "./trajectory-storage.ts";

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

function makeRuntimeWithoutDb(): IAgentRuntime {
  const reportError = vi.fn();
  return {
    agentId: "agent-trajectory-storage-no-db",
    reportError,
    logger: {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
    getService: () => null,
    getServicesByType: () => [],
  } as unknown as IAgentRuntime;
}

function makeRuntimeWithAdapter(options: { countTotal?: number } = {}) {
  const countTotal = options.countTotal ?? 0;
  const execute = vi.fn(async (query: unknown) => {
    const sql = sqlText(query);
    if (/SELECT count\(\*\) AS total/i.test(sql)) {
      return [{ total: countTotal }];
    }
    return [];
  });
  type MockDb = {
    execute: (query: unknown) => Promise<unknown>;
    transaction: <T>(work: (tx: MockDb) => Promise<T>) => Promise<T>;
  };
  const transactionDb: MockDb = {
    execute,
    transaction: async <T>(work: (tx: MockDb) => Promise<T>): Promise<T> =>
      work(transactionDb),
  };
  const db: MockDb = {
    execute,
    transaction: async <T>(work: (tx: MockDb) => Promise<T>): Promise<T> =>
      work(transactionDb),
  };
  const reportError = vi.fn();
  const runtime = {
    agentId: "agent-trajectory-storage-adapter",
    adapter: { db },
    getService: () => null,
    getServicesByType: () => [],
    reportError,
    logger: {
      warn: vi.fn(),
      info: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  } as unknown as IAgentRuntime;
  return { runtime, execute, reportError };
}

describe("__getTrajectoryBridgeStateCountsForTests", () => {
  it("reports empty ownership for a runtime that never started a step", () => {
    expect(
      __getTrajectoryBridgeStateCountsForTests(makeRuntimeWithoutDb()),
    ).toEqual({
      stepMappings: 0,
      activeOwners: 0,
    });
  });
});

describe("flushTrajectoryWrites", () => {
  it("resolves immediately when the write queue is empty", async () => {
    await expect(
      flushTrajectoryWrites(makeRuntimeWithoutDb()),
    ).resolves.toBeUndefined();
  });

  it("resolves immediately for a missing trajectory id", async () => {
    await expect(
      flushTrajectoryWrites(makeRuntimeWithoutDb(), "missing-owner"),
    ).resolves.toBeUndefined();
  });
});

describe("createDatabaseTrajectoryLogger", () => {
  it("returns a trajectories service that can be enabled and disabled", () => {
    const runtime = makeRuntimeWithoutDb();
    const logger = createDatabaseTrajectoryLogger(runtime);
    expect(logger).toBeInstanceOf(DatabaseTrajectoryLogger);
    expect(DatabaseTrajectoryLogger.serviceType).toBe("trajectories");
    expect(DatabaseTrajectoryLogger.allowsMultiple).toBe(true);

    logger.setEnabled(true);
    expect(logger.isEnabled()).toBe(true);
    logger.setEnabled(false);
    expect(logger.isEnabled()).toBe(false);
    expect(__getTrajectoryBridgeStateCountsForTests(runtime)).toEqual({
      stepMappings: 0,
      activeOwners: 0,
    });
  });

  it("returns a UUID and records no ownership when capture is disabled", async () => {
    const runtime = makeRuntimeWithoutDb();
    const logger = createDatabaseTrajectoryLogger(runtime);
    logger.setEnabled(false);

    const started = await logger.startTrajectory("step-disabled", {
      agentId: "agent-trajectory-storage-no-db",
    });
    expect(started).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(started).not.toBe("step-disabled");
    expect(logger.getCurrentStepId("step-disabled")).toBeNull();
    expect(__getTrajectoryBridgeStateCountsForTests(runtime)).toEqual({
      stepMappings: 0,
      activeOwners: 0,
    });
  });

  it("records a single owner for a started trajectory and drops it on release", async () => {
    const runtime = makeRuntimeWithoutDb();
    const logger = createDatabaseTrajectoryLogger(runtime);
    logger.setEnabled(true);

    const stepId = await logger.startTrajectory("step-owner", {
      agentId: "agent-trajectory-storage-no-db",
    });
    expect(stepId).toBe("step-owner");
    expect(logger.getCurrentStepId("step-owner")).toBe("step-owner");
    // Owner id and step id are the same string, so the step map has one entry.
    expect(__getTrajectoryBridgeStateCountsForTests(runtime)).toEqual({
      stepMappings: 1,
      activeOwners: 1,
    });

    logger.releaseTrajectoryOwnership("step-owner");
    expect(logger.getCurrentStepId("step-owner")).toBeNull();
    expect(__getTrajectoryBridgeStateCountsForTests(runtime)).toEqual({
      stepMappings: 0,
      activeOwners: 0,
    });
  });

  it("reports a missing action step instead of inventing a settlement", () => {
    const runtime = makeRuntimeWithoutDb();
    const logger = createDatabaseTrajectoryLogger(runtime);
    logger.setEnabled(true);

    logger.completeStep("traj-missing-action", "step-missing-action");

    expect(runtime.reportError).toHaveBeenCalledWith(
      "TrajectoryStorage.completeStep",
      expect.objectContaining({ code: "TRAJECTORY_ACTION_STEP_REQUIRED" }),
      expect.objectContaining({
        trajectoryId: "traj-missing-action",
        stepId: "step-missing-action",
        diagnosticOnly: true,
      }),
    );
  });

  it("rejects a non-finite delayed reward before touching storage", async () => {
    const logger = createDatabaseTrajectoryLogger(makeRuntimeWithoutDb());
    await expect(
      logger.applyReward({
        trajectoryId: "traj-reward",
        idempotencyKey: "key-1",
        reward: Number.NaN,
        component: "judge",
      }),
    ).rejects.toMatchObject({ code: "TRAJECTORY_REWARD_INVALID" });
    await expect(
      logger.applyReward({
        trajectoryId: "traj-reward",
        idempotencyKey: "key-1",
        reward: Number.POSITIVE_INFINITY,
        component: "judge",
      }),
    ).rejects.toMatchObject({ code: "TRAJECTORY_REWARD_INVALID" });
  });

  it("rejects an invalid child-step timestamp and kind without writing", () => {
    const runtime = makeRuntimeWithoutDb();
    const logger = createDatabaseTrajectoryLogger(runtime);
    logger.setEnabled(true);

    expect(() => logger.startStep("parent-traj", { timestamp: -1 })).toThrow(
      expect.objectContaining({ code: "TRAJECTORY_CAPTURE_INVALID" }),
    );
    expect(() =>
      logger.startStep("parent-traj", {
        kind: "not-a-kind" as "llm",
      }),
    ).toThrow(expect.objectContaining({ code: "TRAJECTORY_CAPTURE_INVALID" }));
    expect(() => logger.startStep("   ")).toThrow(
      expect.objectContaining({ code: "TRAJECTORY_PARENT_REQUIRED" }),
    );
    expect(__getTrajectoryBridgeStateCountsForTests(runtime)).toEqual({
      stepMappings: 0,
      activeOwners: 0,
    });
  });

  it("stop() drains an empty queue and refuses later capture", async () => {
    const runtime = makeRuntimeWithoutDb();
    const logger = createDatabaseTrajectoryLogger(runtime);
    logger.setEnabled(true);

    await logger.stop();
    expect(logger.isEnabled()).toBe(false);
    expect(__getTrajectoryBridgeStateCountsForTests(runtime)).toEqual({
      stepMappings: 0,
      activeOwners: 0,
    });

    const afterStop = await logger.startTrajectory("step-after-stop", {
      agentId: "agent-trajectory-storage-no-db",
    });
    expect(afterStop).not.toBe("step-after-stop");
    expect(__getTrajectoryBridgeStateCountsForTests(runtime)).toEqual({
      stepMappings: 0,
      activeOwners: 0,
    });
  });
});

describe("startTrajectoryStepInDatabase", () => {
  it("returns false when the runtime has no database adapter", async () => {
    await expect(
      startTrajectoryStepInDatabase({
        runtime: makeRuntimeWithoutDb(),
        stepId: "step-1",
      }),
    ).resolves.toBe(false);
  });

  it("returns false for empty or whitespace step ids even with an adapter", async () => {
    const { runtime, execute } = makeRuntimeWithAdapter();
    await expect(
      startTrajectoryStepInDatabase({ runtime, stepId: "" }),
    ).resolves.toBe(false);
    await expect(
      startTrajectoryStepInDatabase({ runtime, stepId: "   " }),
    ).resolves.toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("annotateTrajectoryStep", () => {
  it("returns false when the runtime has no database adapter", async () => {
    await expect(
      annotateTrajectoryStep({
        runtime: makeRuntimeWithoutDb(),
        stepId: "step-1",
        kind: "action",
      }),
    ).resolves.toBe(false);
  });

  it("returns false for a missing step id", async () => {
    const { runtime, execute } = makeRuntimeWithAdapter();
    await expect(
      annotateTrajectoryStep({ runtime, stepId: "\t" }),
    ).resolves.toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("completeTrajectoryStepInDatabase", () => {
  it("returns false when the runtime has no database adapter", async () => {
    await expect(
      completeTrajectoryStepInDatabase({
        runtime: makeRuntimeWithoutDb(),
        stepId: "step-1",
      }),
    ).resolves.toBe(false);
  });

  it("returns false for an empty step id", async () => {
    const { runtime, execute } = makeRuntimeWithAdapter();
    await expect(
      completeTrajectoryStepInDatabase({ runtime, stepId: "" }),
    ).resolves.toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("deletePersistedTrajectoryRows", () => {
  it("throws when storage is unavailable", async () => {
    await expect(
      deletePersistedTrajectoryRows(makeRuntimeWithoutDb(), ["traj-1"]),
    ).rejects.toMatchObject({ code: "TRAJECTORY_DATABASE_UNAVAILABLE" });
  });

  it("returns 0 for an empty id list after schema init, without issuing DELETE", async () => {
    const { runtime, execute } = makeRuntimeWithAdapter();
    await expect(deletePersistedTrajectoryRows(runtime, [])).resolves.toBe(0);
    await expect(
      deletePersistedTrajectoryRows(runtime, ["", "   "]),
    ).resolves.toBe(0);
    const sql = execute.mock.calls.map(([query]) => sqlText(query));
    expect(sql.some((text) => /DELETE FROM trajectories/i.test(text))).toBe(
      false,
    );
  });

  it("returns 0 when the requested id is absent", async () => {
    const { runtime, execute } = makeRuntimeWithAdapter({ countTotal: 0 });
    await expect(
      deletePersistedTrajectoryRows(runtime, ["missing-trajectory"]),
    ).resolves.toBe(0);
    const sql = execute.mock.calls.map(([query]) => sqlText(query));
    expect(
      sql.some((text) => /DELETE FROM trajectories WHERE agent_id/i.test(text)),
    ).toBe(true);
  });
});

describe("clearPersistedTrajectoryRows", () => {
  it("throws when storage is unavailable", async () => {
    await expect(
      clearPersistedTrajectoryRows(makeRuntimeWithoutDb()),
    ).rejects.toMatchObject({ code: "TRAJECTORY_DATABASE_UNAVAILABLE" });
  });

  it("returns 0 when the owner has no persisted rows", async () => {
    const { runtime } = makeRuntimeWithAdapter({ countTotal: 0 });
    await expect(clearPersistedTrajectoryRows(runtime)).resolves.toBe(0);
  });
});

describe("pruneOldTrajectories", () => {
  it("throws when storage is unavailable", async () => {
    await expect(
      pruneOldTrajectories(makeRuntimeWithoutDb()),
    ).rejects.toMatchObject({ code: "TRAJECTORY_DATABASE_UNAVAILABLE" });
  });

  it("returns 0 when nothing is older than the cutoff", async () => {
    const { runtime } = makeRuntimeWithAdapter({ countTotal: 0 });
    await expect(pruneOldTrajectories(runtime, 30)).resolves.toBe(0);
  });
});

describe("installDatabaseTrajectoryLogger", () => {
  it("is a no-op when the runtime has no database adapter", async () => {
    await expect(
      installDatabaseTrajectoryLogger(makeRuntimeWithoutDb()),
    ).resolves.toBeUndefined();
  });

  it("is a no-op when no trajectories logger is registered", async () => {
    const { runtime, execute } = makeRuntimeWithAdapter();
    await expect(
      installDatabaseTrajectoryLogger(runtime),
    ).resolves.toBeUndefined();
    expect(execute).not.toHaveBeenCalled();
  });
});

describe("DatabaseTrajectoryLogger list/detail/delete wrappers", () => {
  it("clamps list limit to [1, 500] and offset to >= 0", async () => {
    const { runtime, execute } = makeRuntimeWithAdapter({ countTotal: 0 });
    const logger = createDatabaseTrajectoryLogger(runtime);
    await logger.initialize();
    execute.mockClear();

    const zero = await logger.listTrajectories({ limit: 0, offset: -4 });
    expect(zero).toEqual({
      trajectories: [],
      total: 0,
      offset: 0,
      limit: 1,
    });
    const overflow = await logger.listTrajectories({
      limit: 9_999,
      offset: 3,
    });
    expect(overflow.limit).toBe(500);
    expect(overflow.offset).toBe(3);

    const sql = execute.mock.calls.map(([query]) => sqlText(query));
    expect(sql.some((text) => /LIMIT 1 OFFSET 0/.test(text))).toBe(true);
    expect(sql.some((text) => /LIMIT 500 OFFSET 3/.test(text))).toBe(true);
  });

  it("returns null for a missing trajectory detail", async () => {
    const { runtime } = makeRuntimeWithAdapter();
    const logger = createDatabaseTrajectoryLogger(runtime);
    await expect(logger.getTrajectoryDetail("missing-row")).resolves.toBeNull();
  });

  it("forwards empty and missing delete lists through the public wrapper", async () => {
    const { runtime } = makeRuntimeWithAdapter({ countTotal: 0 });
    const logger = createDatabaseTrajectoryLogger(runtime);
    await expect(logger.deleteTrajectories([])).resolves.toBe(0);
    await expect(logger.deleteTrajectories(["gone"])).resolves.toBe(0);
    await expect(logger.clearAllTrajectories()).resolves.toBe(0);
  });
});

describe("projectSettledActionDiagnostics", () => {
  it("preserves identity fields and omits llmCallId when it was never set", () => {
    const runtime = {
      redactSecrets: (text: string) => text,
    } as unknown as IAgentRuntime;
    const action: TrajectoryActionAttempt = {
      attemptId: "attempt-plain",
      timestamp: 42,
      actionType: "REPLY",
      actionName: "REPLY",
      parameters: { retries: 1, dryRun: false },
      success: true,
      immediateReward: 0.5,
    };
    const projected = projectSettledActionDiagnostics(runtime, action);
    expect(projected.attemptId).toBe("attempt-plain");
    expect(projected.timestamp).toBe(42);
    expect(projected.actionType).toBe("REPLY");
    expect(projected.actionName).toBe("REPLY");
    expect(projected.parameters.retries).toBe(1);
    expect(projected.parameters.dryRun).toBe(false);
    expect(projected.success).toBe(true);
    expect(projected.immediateReward).toBe(0.5);
    expect(projected.llmCallId).toBeUndefined();
  });
});

describe("projectLlmCallDiagnostics", () => {
  it("keeps provider attribution spans when the prompt text is unchanged", () => {
    const runtime = {
      redactSecrets: (text: string) => text,
    } as unknown as IAgentRuntime;
    const spans = [
      {
        providerName: "CHARACTER",
        sha256: "b".repeat(64),
        spanStart: 0,
        spanEnd: 4,
        tokenCount: 1,
      },
    ];
    const projected = projectLlmCallDiagnostics(runtime, {
      callId: "call-plain",
      prompt: "hello",
      response: "ok",
      providerAttributions: spans,
    });
    expect(projected.callId).toBe("call-plain");
    expect(projected.prompt).toBe("hello");
    expect(projected.response).toBe("ok");
    expect(projected.providerAttributions).toEqual(spans);
  });
});
