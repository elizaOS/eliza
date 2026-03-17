/**
 * Tests for plugin-agent-orchestrator task management actions.
 *
 * Uses mocked runtime and service to validate action behavior without
 * requiring a full Eliza runtime.
 */

import type { ActionResult, IAgentRuntime, Memory, State } from "@elizaos/core";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
  cancelTaskAction,
  createTaskAction,
  listTasksAction,
  pauseTaskAction,
  resumeTaskAction,
  searchTasksAction,
  switchTaskAction,
} from "../src/actions/task-management.js";

// ============================================================================
// Mock helpers
// ============================================================================

function makeRuntime(serviceMap: Record<string, unknown> = {}): IAgentRuntime {
  return {
    getService: vi.fn((name: string) => serviceMap[name] ?? null),
    agentId: "test-agent-id",
  } as unknown as IAgentRuntime;
}

function makeMessage(text: string, roomId = "room-1"): Memory {
  return {
    content: { text },
    roomId,
  } as unknown as Memory;
}

function makeMockService(overrides: Record<string, unknown> = {}) {
  return {
    createTask: vi.fn().mockResolvedValue({
      id: "task-1",
      name: "Test Task",
      metadata: {
        providerId: "mock",
        providerLabel: "Mock Provider",
        status: "pending",
        progress: 0,
      },
    }),
    getRecentTasks: vi.fn().mockResolvedValue([]),
    getCurrentTaskId: vi.fn().mockReturnValue(null),
    getCurrentTask: vi.fn().mockResolvedValue(null),
    searchTasks: vi.fn().mockResolvedValue([]),
    setCurrentTask: vi.fn(),
    pauseTask: vi.fn().mockResolvedValue(undefined),
    resumeTask: vi.fn().mockResolvedValue(undefined),
    cancelTask: vi.fn().mockResolvedValue(undefined),
    addStep: vi.fn().mockResolvedValue({ id: "step-1", description: "test", status: "pending" }),
    appendOutput: vi.fn().mockResolvedValue(undefined),
    startTaskExecution: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

// ============================================================================
// CREATE_TASK
// ============================================================================

describe("createTaskAction", () => {
  it("should have correct name and similes", () => {
    expect(createTaskAction.name).toBe("CREATE_TASK");
    expect(createTaskAction.similes).toContain("START_TASK");
    expect(createTaskAction.similes).toContain("NEW_TASK");
  });

  it("validate returns false when service not available", async () => {
    const runtime = makeRuntime();
    const message = makeMessage("create task");
    expect(await createTaskAction.validate!(runtime, message)).toBe(false);
  });

  it("validate returns true when service exists and text has intent", async () => {
    const svc = makeMockService();
    const runtime = makeRuntime({ CODE_TASK: svc });
    expect(
      await createTaskAction.validate!(runtime, makeMessage("create task for refactoring")),
    ).toBe(true);
    expect(await createTaskAction.validate!(runtime, makeMessage("implement feature X"))).toBe(
      true,
    );
    expect(await createTaskAction.validate!(runtime, makeMessage("fix the login bug"))).toBe(true);
  });

  it("validate returns false when text has no matching intent", async () => {
    const svc = makeMockService();
    const runtime = makeRuntime({ CODE_TASK: svc });
    expect(await createTaskAction.validate!(runtime, makeMessage("hello world"))).toBe(false);
  });

  it("handler creates task and calls callback", async () => {
    const svc = makeMockService();
    const runtime = makeRuntime({ CODE_TASK: svc });
    const callback = vi.fn();
    const message = makeMessage("Create a login page");

    const result = (await createTaskAction.handler(
      runtime,
      message,
      undefined,
      undefined,
      callback,
    )) as ActionResult;

    expect(result.success).toBe(true);
    expect(svc.createTask).toHaveBeenCalledWith(
      "Create a login page",
      "Create a login page",
      "room-1",
    );
    expect(callback).toHaveBeenCalledTimes(1);
    const callbackArg = callback.mock.calls[0][0];
    expect(callbackArg.content.text).toContain("Created task");
  });

  it("handler adds steps when provided via options", async () => {
    const svc = makeMockService();
    const runtime = makeRuntime({ CODE_TASK: svc });
    const callback = vi.fn();
    const message = makeMessage("Build login");

    await createTaskAction.handler(
      runtime,
      message,
      undefined,
      { title: "Auth Feature", description: "Build login", steps: ["Design UI", "Write code"] },
      callback,
    );

    expect(svc.addStep).toHaveBeenCalledTimes(2);
    expect(svc.addStep).toHaveBeenCalledWith("task-1", "Design UI");
    expect(svc.addStep).toHaveBeenCalledWith("task-1", "Write code");
  });

  it("handler throws when service is missing", async () => {
    const runtime = makeRuntime();
    const message = makeMessage("create task");

    await expect(
      createTaskAction.handler(runtime, message, undefined, undefined, undefined),
    ).rejects.toThrow("AgentOrchestratorService not available");
  });
});

// ============================================================================
// LIST_TASKS
// ============================================================================

describe("listTasksAction", () => {
  it("should have correct name", () => {
    expect(listTasksAction.name).toBe("LIST_TASKS");
  });

  it("validate matches relevant text", async () => {
    const svc = makeMockService();
    const runtime = makeRuntime({ CODE_TASK: svc });
    expect(await listTasksAction.validate!(runtime, makeMessage("list tasks"))).toBe(true);
    expect(await listTasksAction.validate!(runtime, makeMessage("show tasks"))).toBe(true);
    expect(await listTasksAction.validate!(runtime, makeMessage("tasks"))).toBe(true);
    expect(await listTasksAction.validate!(runtime, makeMessage("my tasks"))).toBe(true);
  });

  it("handler returns empty message when no tasks", async () => {
    const svc = makeMockService({ getRecentTasks: vi.fn().mockResolvedValue([]) });
    const runtime = makeRuntime({ CODE_TASK: svc });
    const callback = vi.fn();

    const result = (await listTasksAction.handler(
      runtime,
      makeMessage("list tasks"),
      undefined,
      undefined,
      callback,
    )) as ActionResult;

    expect(result.success).toBe(true);
    expect(result.text).toBe("No tasks.");
    expect(callback).toHaveBeenCalledWith({ content: { text: "No tasks." } });
  });

  it("handler lists tasks with status and progress", async () => {
    const svc = makeMockService({
      getRecentTasks: vi.fn().mockResolvedValue([
        { id: "t1", name: "Task Alpha", metadata: { status: "running", progress: 50 } },
        { id: "t2", name: "Task Beta", metadata: { status: "completed", progress: 100 } },
      ]),
      getCurrentTaskId: vi.fn().mockReturnValue("t1"),
    });
    const runtime = makeRuntime({ CODE_TASK: svc });
    const callback = vi.fn();

    const result = (await listTasksAction.handler(
      runtime,
      makeMessage("list tasks"),
      undefined,
      undefined,
      callback,
    )) as ActionResult;

    expect(result.success).toBe(true);
    expect(result.text).toContain("Task Alpha");
    expect(result.text).toContain("(current)");
    expect(result.text).toContain("Task Beta");
    expect(result.text).toContain("completed");
  });
});

// ============================================================================
// SWITCH_TASK
// ============================================================================

describe("switchTaskAction", () => {
  it("should have correct name", () => {
    expect(switchTaskAction.name).toBe("SWITCH_TASK");
  });

  it("validate matches correct phrases", async () => {
    const svc = makeMockService();
    const runtime = makeRuntime({ CODE_TASK: svc });
    expect(await switchTaskAction.validate!(runtime, makeMessage("switch to task login"))).toBe(
      true,
    );
    expect(await switchTaskAction.validate!(runtime, makeMessage("select task auth"))).toBe(true);
  });

  it("handler fails when no query provided (all stop words)", async () => {
    const svc = makeMockService();
    const runtime = makeRuntime({ CODE_TASK: svc });
    const callback = vi.fn();

    const result = (await switchTaskAction.handler(
      runtime,
      makeMessage("switch to task"),
      undefined,
      undefined,
      callback,
    )) as ActionResult;

    expect(result.success).toBe(false);
    expect(result.text).toContain("specify which task");
  });

  it("handler fails when no matching task found", async () => {
    const svc = makeMockService({ searchTasks: vi.fn().mockResolvedValue([]) });
    const runtime = makeRuntime({ CODE_TASK: svc });
    const callback = vi.fn();

    const result = (await switchTaskAction.handler(
      runtime,
      makeMessage("switch to task login-feature"),
      undefined,
      undefined,
      callback,
    )) as ActionResult;

    expect(result.success).toBe(false);
    expect(result.text).toContain("No task found");
  });

  it("handler switches when match found", async () => {
    const svc = makeMockService({
      searchTasks: vi.fn().mockResolvedValue([{ id: "t-99", name: "Login Feature" }]),
    });
    const runtime = makeRuntime({ CODE_TASK: svc });
    const callback = vi.fn();

    const result = (await switchTaskAction.handler(
      runtime,
      makeMessage("switch to task login-feature"),
      undefined,
      undefined,
      callback,
    )) as ActionResult;

    expect(result.success).toBe(true);
    expect(result.text).toContain("Switched to task: Login Feature");
    expect(svc.setCurrentTask).toHaveBeenCalledWith("t-99");
  });
});

// ============================================================================
// SEARCH_TASKS
// ============================================================================

describe("searchTasksAction", () => {
  it("should have correct name", () => {
    expect(searchTasksAction.name).toBe("SEARCH_TASKS");
  });

  it("handler returns prompt when query is empty", async () => {
    const svc = makeMockService();
    const runtime = makeRuntime({ CODE_TASK: svc });
    const callback = vi.fn();

    const result = (await searchTasksAction.handler(
      runtime,
      makeMessage("search task"),
      undefined,
      undefined,
      callback,
    )) as ActionResult;

    expect(result.success).toBe(false);
    expect(result.text).toContain("What would you like to search for?");
  });

  it("handler uses options.query when provided", async () => {
    const svc = makeMockService({
      searchTasks: vi
        .fn()
        .mockResolvedValue([{ name: "Auth Work", metadata: { status: "running", progress: 30 } }]),
    });
    const runtime = makeRuntime({ CODE_TASK: svc });
    const callback = vi.fn();

    const result = (await searchTasksAction.handler(
      runtime,
      makeMessage("search task auth"),
      undefined,
      { query: "auth" },
      callback,
    )) as ActionResult;

    expect(result.success).toBe(true);
    expect(svc.searchTasks).toHaveBeenCalledWith("auth");
    expect(result.text).toContain("Auth Work");
  });

  it("handler reports no results", async () => {
    const svc = makeMockService({ searchTasks: vi.fn().mockResolvedValue([]) });
    const runtime = makeRuntime({ CODE_TASK: svc });
    const callback = vi.fn();

    const result = (await searchTasksAction.handler(
      runtime,
      makeMessage("search task nonexistent-xyz"),
      undefined,
      { query: "nonexistent" },
      callback,
    )) as ActionResult;

    expect(result.success).toBe(true);
    expect(result.text).toContain("No tasks found");
  });
});

// ============================================================================
// PAUSE_TASK
// ============================================================================

describe("pauseTaskAction", () => {
  it("should have correct name", () => {
    expect(pauseTaskAction.name).toBe("PAUSE_TASK");
  });

  it("validate matches pause/stop/halt + task", async () => {
    const svc = makeMockService();
    const runtime = makeRuntime({ CODE_TASK: svc });
    expect(await pauseTaskAction.validate!(runtime, makeMessage("pause task"))).toBe(true);
    expect(await pauseTaskAction.validate!(runtime, makeMessage("stop the task"))).toBe(true);
    expect(await pauseTaskAction.validate!(runtime, makeMessage("halt task"))).toBe(true);
    expect(await pauseTaskAction.validate!(runtime, makeMessage("hello world"))).toBe(false);
  });

  it("handler fails when no task to pause", async () => {
    const svc = makeMockService({
      searchTasks: vi.fn().mockResolvedValue([]),
      getCurrentTask: vi.fn().mockResolvedValue(null),
    });
    const runtime = makeRuntime({ CODE_TASK: svc });
    const callback = vi.fn();

    const result = (await pauseTaskAction.handler(
      runtime,
      makeMessage("pause task"),
      undefined,
      undefined,
      callback,
    )) as ActionResult;

    expect(result.success).toBe(false);
    expect(result.text).toBe("No task to pause.");
  });

  it("handler pauses current task when no query text", async () => {
    const svc = makeMockService({
      getCurrentTask: vi.fn().mockResolvedValue({ id: "t-1", name: "Running Work" }),
    });
    const runtime = makeRuntime({ CODE_TASK: svc });
    const callback = vi.fn();

    const result = (await pauseTaskAction.handler(
      runtime,
      makeMessage("pause task"),
      undefined,
      undefined,
      callback,
    )) as ActionResult;

    expect(result.success).toBe(true);
    expect(result.text).toContain("Paused task: Running Work");
    expect(svc.pauseTask).toHaveBeenCalledWith("t-1");
  });
});

// ============================================================================
// RESUME_TASK
// ============================================================================

describe("resumeTaskAction", () => {
  it("should have correct name", () => {
    expect(resumeTaskAction.name).toBe("RESUME_TASK");
  });

  it("validate matches resume/continue/restart + task", async () => {
    const svc = makeMockService();
    const runtime = makeRuntime({ CODE_TASK: svc });
    expect(await resumeTaskAction.validate!(runtime, makeMessage("resume task"))).toBe(true);
    expect(await resumeTaskAction.validate!(runtime, makeMessage("continue the task"))).toBe(true);
    expect(await resumeTaskAction.validate!(runtime, makeMessage("restart task"))).toBe(true);
  });

  it("handler fails when no task to resume", async () => {
    const svc = makeMockService({
      searchTasks: vi.fn().mockResolvedValue([]),
      getCurrentTask: vi.fn().mockResolvedValue(null),
    });
    const runtime = makeRuntime({ CODE_TASK: svc });
    const callback = vi.fn();

    const result = (await resumeTaskAction.handler(
      runtime,
      makeMessage("resume task"),
      undefined,
      undefined,
      callback,
    )) as ActionResult;

    expect(result.success).toBe(false);
    expect(result.text).toBe("No task to resume.");
  });

  it("handler resumes and starts execution", async () => {
    const svc = makeMockService({
      getCurrentTask: vi.fn().mockResolvedValue({ id: "t-2", name: "Paused Work" }),
    });
    const runtime = makeRuntime({ CODE_TASK: svc });
    const callback = vi.fn();

    const result = (await resumeTaskAction.handler(
      runtime,
      makeMessage("resume task"),
      undefined,
      undefined,
      callback,
    )) as ActionResult;

    expect(result.success).toBe(true);
    expect(result.text).toContain("Resumed task: Paused Work");
    expect(svc.resumeTask).toHaveBeenCalledWith("t-2");
    expect(svc.startTaskExecution).toHaveBeenCalledWith("t-2");
  });
});

// ============================================================================
// CANCEL_TASK
// ============================================================================

describe("cancelTaskAction", () => {
  it("should have correct name and similes", () => {
    expect(cancelTaskAction.name).toBe("CANCEL_TASK");
    expect(cancelTaskAction.similes).toContain("DELETE_TASK");
    expect(cancelTaskAction.similes).toContain("REMOVE_TASK");
  });

  it("validate matches cancel/delete/remove + task", async () => {
    const svc = makeMockService();
    const runtime = makeRuntime({ CODE_TASK: svc });
    expect(await cancelTaskAction.validate!(runtime, makeMessage("cancel task"))).toBe(true);
    expect(await cancelTaskAction.validate!(runtime, makeMessage("delete task"))).toBe(true);
    expect(await cancelTaskAction.validate!(runtime, makeMessage("remove the task"))).toBe(true);
    expect(await cancelTaskAction.validate!(runtime, makeMessage("hello world"))).toBe(false);
  });

  it("handler fails when no task to cancel", async () => {
    const svc = makeMockService({
      searchTasks: vi.fn().mockResolvedValue([]),
      getCurrentTask: vi.fn().mockResolvedValue(null),
    });
    const runtime = makeRuntime({ CODE_TASK: svc });
    const callback = vi.fn();

    const result = (await cancelTaskAction.handler(
      runtime,
      makeMessage("cancel task"),
      undefined,
      undefined,
      callback,
    )) as ActionResult;

    expect(result.success).toBe(false);
    expect(result.text).toBe("No task to cancel.");
  });

  it("handler cancels matching task by query", async () => {
    const svc = makeMockService({
      searchTasks: vi.fn().mockResolvedValue([{ id: "t-5", name: "Login Feature" }]),
    });
    const runtime = makeRuntime({ CODE_TASK: svc });
    const callback = vi.fn();

    const result = (await cancelTaskAction.handler(
      runtime,
      makeMessage("cancel task login-feature"),
      undefined,
      undefined,
      callback,
    )) as ActionResult;

    expect(result.success).toBe(true);
    expect(result.text).toContain("Cancelled task: Login Feature");
    expect(svc.cancelTask).toHaveBeenCalledWith("t-5");
  });

  it("handler cancels current task when no query", async () => {
    const svc = makeMockService({
      getCurrentTask: vi.fn().mockResolvedValue({ id: "t-3", name: "Current Work" }),
    });
    const runtime = makeRuntime({ CODE_TASK: svc });
    const callback = vi.fn();

    const result = (await cancelTaskAction.handler(
      runtime,
      makeMessage("cancel task"),
      undefined,
      undefined,
      callback,
    )) as ActionResult;

    expect(result.success).toBe(true);
    expect(result.text).toContain("Cancelled task: Current Work");
    expect(svc.cancelTask).toHaveBeenCalledWith("t-3");
  });
});
