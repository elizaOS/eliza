/**
 * Verifies TASKS archive/reopen lifecycle (#11028).
 * Deterministic unit test with a stubbed runtime; no live model.
 */
import { describe, expect, it, vi } from "vitest";
import {
  archiveCodingTaskAction,
  reopenCodingTaskAction,
} from "../../src/actions/tasks.js";
import {
  callback,
  memory,
  runtimeWith,
  state,
} from "../../src/test-utils/action-test-utils.js";

// A minimal OrchestratorTaskService double exposing only the durable lifecycle
// methods the action wiring calls. `runtimeWith` returns it for every
// getService() lookup, which is all these paths need.
function taskServiceMock() {
  return {
    listSessions: () => [],
    archiveTask: vi.fn(async (id: string) =>
      id === "t1" ? { task: { id, archived: true }, sessions: [] } : null,
    ),
    reopenTask: vi.fn(async (id: string) =>
      id === "t1" ? { task: { id, archived: false }, sessions: [] } : null,
    ),
    pauseTask: vi.fn(async (id: string) =>
      id === "t1" ? { task: { id, paused: true }, sessions: [] } : null,
    ),
  };
}

const opts = (parameters: Record<string, unknown>) => ({ parameters });

describe("TASKS archive/reopen lifecycle (#11028)", () => {
  it("keeps archive and reopen planner-visible on the umbrella action", () => {
    const actions = archiveCodingTaskAction.parameters?.find(
      (parameter) => parameter.name === "action",
    )?.schema.enum;
    expect(actions).toContain("archive");
    expect(actions).toContain("reopen");
  });

  it("archives a task through the durable service (was UNSUPPORTED_OPERATION)", async () => {
    const svc = taskServiceMock();
    const result = await archiveCodingTaskAction.handler(
      runtimeWith(svc),
      memory({}),
      state,
      opts({ action: "archive", taskId: "t1" }),
      callback(),
    );
    expect(svc.archiveTask).toHaveBeenCalledWith("t1");
    expect(result?.success).toBe(true);
    expect(result?.data).toMatchObject({
      taskId: "t1",
      task: { task: { id: "t1", archived: true } },
    });
    expect(result?.effectReceipts).toEqual([
      expect.objectContaining({
        outcome: "applied",
        resource: { kind: "orchestrator.task", id: "t1" },
      }),
    ]);
  });

  it("reopens a task through the durable service", async () => {
    const svc = taskServiceMock();
    const result = await reopenCodingTaskAction.handler(
      runtimeWith(svc),
      memory({}),
      state,
      opts({ action: "reopen", taskId: "t1" }),
      callback(),
    );
    expect(svc.reopenTask).toHaveBeenCalledWith("t1");
    expect(result?.success).toBe(true);
    expect(result?.data).toMatchObject({
      taskId: "t1",
      task: { task: { id: "t1", archived: false } },
    });
  });

  it("pauses a task via the control action (archive/reopen/pause all route to the service)", async () => {
    const svc = taskServiceMock();
    const result = await archiveCodingTaskAction.handler(
      runtimeWith(svc),
      memory({}),
      state,
      opts({ action: "control", controlAction: "pause", taskId: "t1" }),
      callback(),
    );
    expect(svc.pauseTask).toHaveBeenCalledWith("t1");
    expect(result?.success).toBe(true);
    expect(result?.effectReceipts).toEqual([
      expect.objectContaining({
        outcome: "applied",
        resource: { kind: "orchestrator.task", id: "t1" },
      }),
    ]);
    expect(result?.userFacingEffectReceiptIds).toEqual([
      result?.effectReceipts?.[0]?.receiptId,
    ]);
  });

  it.each(["archive", "reopen"] as const)(
    "binds control/%s to the same durable effect proof as its top-level alias",
    async (controlAction) => {
      const svc = taskServiceMock();
      const result = await archiveCodingTaskAction.handler(
        runtimeWith(svc),
        memory({}),
        state,
        opts({ action: "control", controlAction, taskId: "t1" }),
        callback(),
      );

      expect(result?.success).toBe(true);
      expect(result?.effectReceipts).toEqual([
        expect.objectContaining({
          outcome: "applied",
          resource: { kind: "orchestrator.task", id: "t1" },
        }),
      ]);
      expect(result?.userFacingEffectReceiptIds).toEqual([
        result?.effectReceipts?.[0]?.receiptId,
      ]);
    },
  );

  it("reports TASK_NOT_FOUND for an unknown task", async () => {
    const svc = taskServiceMock();
    const result = await archiveCodingTaskAction.handler(
      runtimeWith(svc),
      memory({}),
      state,
      opts({ action: "archive", taskId: "ghost" }),
      callback(),
    );
    expect(result?.success).toBe(false);
    expect(result?.error).toBe("TASK_NOT_FOUND");
  });

  it("requires a taskId", async () => {
    const svc = taskServiceMock();
    const result = await archiveCodingTaskAction.handler(
      runtimeWith(svc),
      memory({}),
      state,
      opts({ action: "archive" }),
      callback(),
    );
    expect(result?.error).toBe("MISSING_TASK_ID");
  });

  it("still reports UNSUPPORTED_OPERATION in true ACP-only mode (no task service)", async () => {
    const result = await archiveCodingTaskAction.handler(
      runtimeWith(undefined),
      memory({}),
      state,
      opts({ action: "archive", taskId: "t1" }),
      callback(),
    );
    expect(result?.error).toBe("UNSUPPORTED_OPERATION");
  });
});
