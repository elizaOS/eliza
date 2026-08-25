/**
 * Behavioral coverage for trajectory-steps-writer.ts CQRS writes. Drives the
 * real writer: typed storage and parent errors, upsert insert vs in-place
 * replace, parentStepId override including null, replace sort/ties/empty/
 * single-element, delete empty-queue and whitespace IDs, ownership SQL, and
 * clear-all counts. sqlQuote and extractRequiredRows stay real; load, save,
 * and transaction are stubbed collaborators so writer-owned branches can be
 * asserted without a SQL engine.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  executeRawSqlTransaction,
  loadTrajectoryById,
  type PersistedStep,
  type PersistedTrajectory,
  type RawSqlExecutor,
  saveTrajectory,
} from "./trajectory-internals.ts";
import {
  clearAllSteps,
  deleteStepsForTrajectories,
  replaceStepsForTrajectory,
  upsertStep,
} from "./trajectory-steps-writer.ts";

vi.mock("./trajectory-internals.ts", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./trajectory-internals.ts")>();
  return {
    ...actual,
    loadTrajectoryById: vi.fn(),
    saveTrajectory: vi.fn(),
    executeRawSqlTransaction: vi.fn(),
  };
});

const loadTrajectoryByIdMock = vi.mocked(loadTrajectoryById);
const saveTrajectoryMock = vi.mocked(saveTrajectory);
const executeRawSqlTransactionMock = vi.mocked(executeRawSqlTransaction);

function runtimeWithDb(agentId = "agent-writer"): IAgentRuntime {
  return {
    agentId,
    adapter: {
      db: {
        execute: async () => ({ rows: [] }),
      },
    },
  } as unknown as IAgentRuntime;
}

function runtimeWithoutDb(agentId = "agent-no-db"): IAgentRuntime {
  return { agentId } as unknown as IAgentRuntime;
}

function makeStep(
  overrides: Partial<PersistedStep> &
    Pick<PersistedStep, "stepId" | "stepNumber">,
): PersistedStep {
  return {
    timestamp: 1_700_000_000_000,
    llmCalls: [],
    providerAccesses: [],
    ...overrides,
  };
}

function makeTrajectory(
  overrides: Partial<PersistedTrajectory> = {},
): PersistedTrajectory {
  return {
    id: "traj-1",
    agentId: "agent-writer",
    source: "test",
    status: "active",
    startTime: 1_700_000_000_000,
    endTime: null,
    steps: [],
    metadata: {},
    metrics: {},
    rewardComponents: { environmentReward: 0 },
    totalReward: 0,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function captureSql(result: unknown): { sql: string[] } {
  const sql: string[] = [];
  const execute: RawSqlExecutor = async (sqlText) => {
    sql.push(sqlText);
    return result;
  };
  executeRawSqlTransactionMock.mockImplementation(async (_runtime, work) =>
    work(execute),
  );
  return { sql };
}

describe("trajectory-steps-writer", () => {
  beforeEach(() => {
    loadTrajectoryByIdMock.mockReset();
    saveTrajectoryMock.mockReset();
    executeRawSqlTransactionMock.mockReset();
    saveTrajectoryMock.mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("upsertStep", () => {
    it("throws TRAJECTORY_DATABASE_UNAVAILABLE when storage is missing", async () => {
      const step = makeStep({ stepId: "s1", stepNumber: 0 });
      await expect(
        upsertStep(runtimeWithoutDb(), "traj-1", step),
      ).rejects.toMatchObject({
        code: "TRAJECTORY_DATABASE_UNAVAILABLE",
      });
      expect(loadTrajectoryByIdMock).not.toHaveBeenCalled();
      expect(saveTrajectoryMock).not.toHaveBeenCalled();
    });

    it("throws TRAJECTORY_PARENT_NOT_FOUND when the parent trajectory is missing", async () => {
      const runtime = runtimeWithDb();
      const step = makeStep({ stepId: "orphan-step", stepNumber: 0 });
      loadTrajectoryByIdMock.mockResolvedValue(null);

      await expect(
        upsertStep(runtime, "missing-traj", step),
      ).rejects.toMatchObject({
        code: "TRAJECTORY_PARENT_NOT_FOUND",
        context: { trajectoryId: "missing-traj", stepId: "orphan-step" },
      });
      expect(saveTrajectoryMock).not.toHaveBeenCalled();
    });

    it("appends a new step onto an empty queue and stamps updatedAt", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-23T12:00:00.000Z"));
      const runtime = runtimeWithDb();
      const trajectory = makeTrajectory();
      const step = makeStep({ stepId: "new-step", stepNumber: 0 });
      loadTrajectoryByIdMock.mockResolvedValue(trajectory);

      await upsertStep(runtime, trajectory.id, step);

      expect(trajectory.steps).toEqual([step]);
      expect(trajectory.updatedAt).toBe("2026-08-23T12:00:00.000Z");
      expect(saveTrajectoryMock).toHaveBeenCalledWith(runtime, trajectory, {
        changedStepIds: ["new-step"],
        updateLegacySnapshot: true,
      });
    });

    it("appends a new step after existing rows instead of replacing them", async () => {
      const runtime = runtimeWithDb();
      const existing = makeStep({ stepId: "keep", stepNumber: 0 });
      const incoming = makeStep({ stepId: "added", stepNumber: 1 });
      const trajectory = makeTrajectory({ steps: [existing] });
      loadTrajectoryByIdMock.mockResolvedValue(trajectory);

      await upsertStep(runtime, trajectory.id, incoming);

      expect(trajectory.steps).toEqual([existing, incoming]);
      expect(trajectory.steps[0]).toBe(existing);
    });

    it("replaces the matching step in place, including a middle index", async () => {
      const runtime = runtimeWithDb();
      const first = makeStep({ stepId: "a", stepNumber: 0 });
      const middle = makeStep({
        stepId: "b",
        stepNumber: 1,
        script: "old-script",
      });
      const last = makeStep({ stepId: "c", stepNumber: 2 });
      const replacement = makeStep({
        stepId: "b",
        stepNumber: 1,
        script: "new-script",
      });
      const trajectory = makeTrajectory({ steps: [first, middle, last] });
      loadTrajectoryByIdMock.mockResolvedValue(trajectory);

      await upsertStep(runtime, trajectory.id, replacement);

      expect(trajectory.steps).toHaveLength(3);
      expect(trajectory.steps[0]).toBe(first);
      expect(trajectory.steps[1]).toEqual(replacement);
      expect(trajectory.steps[1]).not.toBe(middle);
      expect(trajectory.steps[2]).toBe(last);
      expect(saveTrajectoryMock).toHaveBeenCalledWith(runtime, trajectory, {
        changedStepIds: ["b"],
        updateLegacySnapshot: true,
      });
    });

    it("leaves parentStepId unchanged when the override argument is omitted", async () => {
      const runtime = runtimeWithDb();
      const step = makeStep({
        stepId: "child",
        stepNumber: 1,
        parentStepId: "original-parent",
      });
      const trajectory = makeTrajectory();
      loadTrajectoryByIdMock.mockResolvedValue(trajectory);

      await upsertStep(runtime, trajectory.id, step);

      expect(trajectory.steps[0]?.parentStepId).toBe("original-parent");
    });

    it("overrides parentStepId when a parent id is provided", async () => {
      const runtime = runtimeWithDb();
      const step = makeStep({
        stepId: "child",
        stepNumber: 1,
        parentStepId: "original-parent",
      });
      const trajectory = makeTrajectory();
      loadTrajectoryByIdMock.mockResolvedValue(trajectory);

      await upsertStep(runtime, trajectory.id, step, "wired-parent");

      expect(trajectory.steps[0]?.parentStepId).toBe("wired-parent");
    });

    it("clears parentStepId when the override is null", async () => {
      const runtime = runtimeWithDb();
      const step = makeStep({
        stepId: "child",
        stepNumber: 1,
        parentStepId: "original-parent",
      });
      const trajectory = makeTrajectory();
      loadTrajectoryByIdMock.mockResolvedValue(trajectory);

      await upsertStep(runtime, trajectory.id, step, null);

      expect(trajectory.steps[0]?.parentStepId).toBeUndefined();
    });

    it("accepts a runtime whose db is only on databaseAdapter", async () => {
      const runtime = {
        agentId: "legacy-agent",
        databaseAdapter: {
          db: {
            execute: async () => ({ rows: [] }),
          },
        },
      } as unknown as IAgentRuntime;
      const trajectory = makeTrajectory({ agentId: "legacy-agent" });
      const step = makeStep({ stepId: "legacy-step", stepNumber: 0 });
      loadTrajectoryByIdMock.mockResolvedValue(trajectory);

      await upsertStep(runtime, trajectory.id, step);

      expect(saveTrajectoryMock).toHaveBeenCalledOnce();
    });
  });

  describe("replaceStepsForTrajectory", () => {
    it("throws TRAJECTORY_DATABASE_UNAVAILABLE when storage is missing", async () => {
      await expect(
        replaceStepsForTrajectory(runtimeWithoutDb(), "traj-1", []),
      ).rejects.toMatchObject({
        code: "TRAJECTORY_DATABASE_UNAVAILABLE",
      });
      expect(loadTrajectoryByIdMock).not.toHaveBeenCalled();
    });

    it("throws TRAJECTORY_PARENT_NOT_FOUND without a stepId in context", async () => {
      const runtime = runtimeWithDb();
      loadTrajectoryByIdMock.mockResolvedValue(null);

      await expect(
        replaceStepsForTrajectory(runtime, "missing-traj", [
          makeStep({ stepId: "s1", stepNumber: 0 }),
        ]),
      ).rejects.toMatchObject({
        code: "TRAJECTORY_PARENT_NOT_FOUND",
        context: { trajectoryId: "missing-traj" },
      });
      expect(saveTrajectoryMock).not.toHaveBeenCalled();
    });

    it("replaces with an empty step list", async () => {
      const runtime = runtimeWithDb();
      const trajectory = makeTrajectory({
        steps: [makeStep({ stepId: "gone", stepNumber: 0 })],
      });
      loadTrajectoryByIdMock.mockResolvedValue(trajectory);

      await replaceStepsForTrajectory(runtime, trajectory.id, []);

      expect(trajectory.steps).toEqual([]);
      expect(saveTrajectoryMock).toHaveBeenCalledWith(runtime, trajectory);
    });

    it("keeps a single-element replacement in the same order", async () => {
      const runtime = runtimeWithDb();
      const only = makeStep({ stepId: "only", stepNumber: 7 });
      const trajectory = makeTrajectory();
      loadTrajectoryByIdMock.mockResolvedValue(trajectory);

      await replaceStepsForTrajectory(runtime, trajectory.id, [only]);

      expect(trajectory.steps).toEqual([only]);
      expect(trajectory.steps[0]).toBe(only);
    });

    it("sorts by stepNumber without mutating the caller array", async () => {
      const runtime = runtimeWithDb();
      const late = makeStep({ stepId: "late", stepNumber: 5 });
      const negative = makeStep({ stepId: "neg", stepNumber: -1 });
      const zero = makeStep({ stepId: "zero", stepNumber: 0 });
      const input = [late, negative, zero];
      const snapshot = [...input];
      const trajectory = makeTrajectory();
      loadTrajectoryByIdMock.mockResolvedValue(trajectory);

      await replaceStepsForTrajectory(runtime, trajectory.id, input);

      expect(input).toEqual(snapshot);
      expect(trajectory.steps.map((step) => step.stepId)).toEqual([
        "neg",
        "zero",
        "late",
      ]);
    });

    it("keeps original order for equal stepNumber ties", async () => {
      const runtime = runtimeWithDb();
      const first = makeStep({ stepId: "first", stepNumber: 1 });
      const second = makeStep({ stepId: "second", stepNumber: 1 });
      const third = makeStep({ stepId: "third", stepNumber: 1 });
      const trajectory = makeTrajectory();
      loadTrajectoryByIdMock.mockResolvedValue(trajectory);

      await replaceStepsForTrajectory(runtime, trajectory.id, [
        first,
        second,
        third,
      ]);

      expect(trajectory.steps.map((step) => step.stepId)).toEqual([
        "first",
        "second",
        "third",
      ]);
    });

    it("stamps updatedAt and does not pass upsert save options", async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-23T15:30:00.000Z"));
      const runtime = runtimeWithDb();
      const trajectory = makeTrajectory();
      loadTrajectoryByIdMock.mockResolvedValue(trajectory);

      await replaceStepsForTrajectory(runtime, trajectory.id, [
        makeStep({ stepId: "s", stepNumber: 0 }),
      ]);

      expect(trajectory.updatedAt).toBe("2026-08-23T15:30:00.000Z");
      expect(saveTrajectoryMock.mock.calls[0]?.[2]).toBeUndefined();
    });
  });

  describe("deleteStepsForTrajectories", () => {
    it("throws TRAJECTORY_DATABASE_UNAVAILABLE when storage is missing", async () => {
      await expect(
        deleteStepsForTrajectories(runtimeWithoutDb(), ["traj-1"]),
      ).rejects.toMatchObject({
        code: "TRAJECTORY_DATABASE_UNAVAILABLE",
      });
      expect(executeRawSqlTransactionMock).not.toHaveBeenCalled();
    });

    it("returns 0 for an empty id list without opening a transaction", async () => {
      const runtime = runtimeWithDb();
      await expect(deleteStepsForTrajectories(runtime, [])).resolves.toBe(0);
      expect(executeRawSqlTransactionMock).not.toHaveBeenCalled();
    });

    it("returns 0 when every id is blank or whitespace", async () => {
      const runtime = runtimeWithDb();
      await expect(
        deleteStepsForTrajectories(runtime, ["", "   ", "\t", "\n"]),
      ).resolves.toBe(0);
      expect(executeRawSqlTransactionMock).not.toHaveBeenCalled();
    });

    it("trims ids, quotes apostrophes, and scopes delete to the runtime agent", async () => {
      const runtime = runtimeWithDb("agent's-id");
      const { sql } = captureSql({
        rows: [{ trajectory_id: "traj-1" }, { trajectory_id: "traj-2" }],
      });

      const deleted = await deleteStepsForTrajectories(runtime, [
        "  traj-1  ",
        "",
        "traj-2",
        "it's",
      ]);

      expect(deleted).toBe(2);
      expect(sql).toHaveLength(1);
      const statement = sql[0] ?? "";
      expect(statement).toContain("DELETE FROM trajectory_steps");
      expect(statement).toContain("RETURNING trajectory_id");
      expect(statement).toContain("agent_id = 'agent''s-id'");
      expect(statement).toContain("'traj-1'");
      expect(statement).toContain("'traj-2'");
      expect(statement).toContain("'it''s'");
      expect(statement).not.toMatch(/''\s*,/);
    });

    it("returns 0 when the delete matches no rows", async () => {
      const runtime = runtimeWithDb();
      captureSql({ rows: [] });

      await expect(
        deleteStepsForTrajectories(runtime, ["missing-traj"]),
      ).resolves.toBe(0);
    });

    it("counts returned rows rather than unique trajectory ids", async () => {
      const runtime = runtimeWithDb();
      captureSql({
        rows: [
          { trajectory_id: "dup" },
          { trajectory_id: "dup" },
          { trajectory_id: "other" },
        ],
      });

      await expect(
        deleteStepsForTrajectories(runtime, ["dup", "other"]),
      ).resolves.toBe(3);
    });

    it("rejects a malformed SQL result instead of reporting an empty delete", async () => {
      const runtime = runtimeWithDb();
      captureSql({});

      await expect(
        deleteStepsForTrajectories(runtime, ["traj-1"]),
      ).rejects.toMatchObject({
        code: "TRAJECTORY_ROW_INVALID",
        context: { operation: "delete trajectory steps" },
      });
    });
  });

  describe("clearAllSteps", () => {
    it("throws TRAJECTORY_DATABASE_UNAVAILABLE when storage is missing", async () => {
      await expect(clearAllSteps(runtimeWithoutDb())).rejects.toMatchObject({
        code: "TRAJECTORY_DATABASE_UNAVAILABLE",
      });
      expect(executeRawSqlTransactionMock).not.toHaveBeenCalled();
    });

    it("deletes every step owned by the runtime agent and returns the row count", async () => {
      const runtime = runtimeWithDb("clear-agent");
      const { sql } = captureSql({
        rows: [{ trajectory_id: "t1" }, { trajectory_id: "t2" }],
      });

      await expect(clearAllSteps(runtime)).resolves.toBe(2);
      expect(sql).toHaveLength(1);
      const statement = sql[0] ?? "";
      expect(statement).toContain("DELETE FROM trajectory_steps");
      expect(statement).toContain("trajectory_id IN (");
      expect(statement).toContain(
        "SELECT id FROM trajectories WHERE agent_id = 'clear-agent'",
      );
      expect(statement).toContain("RETURNING trajectory_id");
      expect(statement).not.toMatch(/AND id IN \(/);
    });

    it("returns 0 when the agent owns no step rows", async () => {
      const runtime = runtimeWithDb();
      captureSql({ rows: [] });
      await expect(clearAllSteps(runtime)).resolves.toBe(0);
    });

    it("rejects a malformed SQL result instead of reporting an empty clear", async () => {
      const runtime = runtimeWithDb();
      captureSql({});

      await expect(clearAllSteps(runtime)).rejects.toMatchObject({
        code: "TRAJECTORY_ROW_INVALID",
        context: { operation: "clear trajectory steps" },
      });
    });
  });
});
