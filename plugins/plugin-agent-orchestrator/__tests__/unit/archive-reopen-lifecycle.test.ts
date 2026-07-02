import { describe, expect, it, vi } from "vitest";
import {
  archiveCodingTaskAction,
  reopenCodingTaskAction,
} from "../../src/actions/tasks.js";
import {
  callback,
  memory,
  runtimeWith,
  serviceMock,
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
    // TaskThreadDetailDto keeps `paused` at the top level.
    pauseTask: vi.fn(async (id: string) =>
      id === "t1" ? { id, paused: true, sessions: [] } : null,
    ),
    resumeTask: vi.fn(async (id: string) =>
      id === "t1" ? { id, paused: false, sessions: [] } : null,
    ),
  };
}

const opts = (parameters: Record<string, unknown>) => ({ parameters });

describe("TASKS archive/reopen lifecycle (#11028)", () => {
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
  });

  it("resumes a paused task through the durable service (pause→resume no longer dead-ends in SESSION_NOT_FOUND)", async () => {
    const svc = taskServiceMock();
    // pauseTask sets paused:true AND stops the task's active sessions, so the
    // mock's empty listSessions() mirrors the real post-pause state.
    await archiveCodingTaskAction.handler(
      runtimeWith(svc),
      memory({}),
      state,
      opts({ action: "control", controlAction: "pause", taskId: "t1" }),
      callback(),
    );
    const result = await archiveCodingTaskAction.handler(
      runtimeWith(svc),
      memory({}),
      state,
      opts({ action: "control", controlAction: "resume", taskId: "t1" }),
      callback(),
    );
    expect(svc.resumeTask).toHaveBeenCalledWith("t1");
    expect(result?.success).toBe(true);
    expect(result?.error).not.toBe("SESSION_NOT_FOUND");
    const task = (result?.data as { task?: { paused?: boolean } })?.task;
    expect(task?.paused).toBe(false);
  });

  it("keeps session-scoped resume (no taskId) on the ACP path", async () => {
    const svc = serviceMock();
    const result = await archiveCodingTaskAction.handler(
      runtimeWith(svc),
      memory({ text: "resume" }),
      state,
      opts({
        action: "control",
        controlAction: "resume",
        instruction: "keep going",
      }),
      callback(),
    );
    expect(svc.sendToSession).toHaveBeenCalledWith(
      "abcdef123456",
      "keep going",
    );
    expect(result?.success).toBe(true);
  });

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
