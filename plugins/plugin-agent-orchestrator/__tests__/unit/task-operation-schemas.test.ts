import { promoteSubactionsToActions } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { taskOperationSchemaOverrides } from "../../src/actions/task-operation-schemas.js";
import { tasksAction } from "../../src/actions/tasks.js";
import {
  callback,
  memory,
  runtimeWith,
  serviceMock,
  state,
} from "../../src/test-utils/action-test-utils.js";

function operations() {
  return promoteSubactionsToActions(tasksAction, {
    overrides: taskOperationSchemaOverrides(tasksAction),
  });
}
function operation(name: string) {
  const action = operations().find((action) => action.name === name);
  if (!action) throw new Error(`Missing ${name}`);
  return action;
}
function fields(name: string) {
  return operation(name).parameters?.map((parameter) => parameter.name) ?? [];
}

describe("TASKS operation contracts", () => {
  it("advertises an argument-free list without sibling creation or mutation fields", async () => {
    const list = operation("TASKS_LIST_AGENTS");
    // The discriminator is synthesized by promotion, not a selectable operation.
    expect(fields(list.name).filter((name) => name !== "action")).toEqual([]);
    const svc = serviceMock();
    svc.listSessions.mockReturnValue([]);
    const result = await list.handler(
      runtimeWith(svc),
      memory(),
      state,
      { parameters: {} },
      callback(),
    );
    expect(result).toMatchObject({ success: true, data: { sessions: [] } });
    expect(svc.spawnSession).not.toHaveBeenCalled();
  });

  it("retains creation inputs and verification contracts without sibling operations", () => {
    const create = fields("TASKS_CREATE");
    expect(create).toEqual(
      expect.arrayContaining([
        "task",
        "agents",
        "dependencies",
        "maxParallel",
        "projectId",
        "title",
        "requestedBackend",
        "metadata",
        "validator",
        "maxRetries",
        "onVerificationFail",
        "taskRoomId",
        "worktreeRoomId",
      ]),
    );
    for (const sibling of [
      "issueNumber",
      "controlAction",
      "input",
      "statuses",
      "skipPR",
      "op",
      "operation",
      "subaction",
    ]) {
      expect(create).not.toContain(sibling);
    }
    const spawn = operation("TASKS_SPAWN_AGENT");
    expect(
      spawn.parameters?.find((parameter) => parameter.name === "task")
        ?.required,
    ).toBe(true);
    expect(fields(spawn.name)).toContain("deferUserReply");
    expect(fields(spawn.name)).not.toContain("dependencies");
  });

  it("keeps ownership and compatibility checks on every promoted action", async () => {
    const originalParameters = structuredClone(tasksAction.parameters);
    for (const action of operations().filter(
      (action) => action.name !== "TASKS",
    )) {
      expect(action.roleGate).toEqual(tasksAction.roleGate);
      expect(action.suppressEarlyReply).toBe(true);
      expect(action.asyncHandoff).toBe(true);
    }
    const svc = serviceMock();
    const result = await operation("TASKS_LIST_AGENTS").handler(
      runtimeWith(svc),
      memory(),
      state,
      { parameters: { op: "create", task: "write a file" } },
      callback(),
    );
    expect(result).toMatchObject({
      success: false,
      text: expect.stringContaining("TASKS_CREATE"),
    });
    expect(svc.spawnSession).not.toHaveBeenCalled();
    expect(tasksAction.parameters).toEqual(originalParameters);
  });

  it("keeps workspace, issue, and lifecycle contracts distinct", () => {
    expect(fields("TASKS_MANAGE_ISSUES")).toEqual(
      expect.arrayContaining([
        "repo",
        "issueAction",
        "issueNumber",
        "body",
        "labels",
      ]),
    );
    expect(fields("TASKS_SUBMIT_WORKSPACE")).toContain("workspaceId");
    expect(fields("TASKS_SUBMIT_WORKSPACE")).not.toContain("issueNumber");
    expect(fields("TASKS_ARCHIVE").filter((name) => name !== "action")).toEqual(
      ["taskId", "threadId"],
    );
    expect(fields("TASKS_HISTORY")).toEqual(
      expect.arrayContaining([
        "sessionId",
        "statuses",
        "window",
        "includeArchived",
        "projectId",
      ]),
    );
  });
});
