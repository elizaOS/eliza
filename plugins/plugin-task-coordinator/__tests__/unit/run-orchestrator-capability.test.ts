// Runtime dispatch tests for the orchestrator TUI view's 15 capabilities
// (src/orchestrator-capabilities.ts). The existing capability-parity test only
// reads source text; this test actually executes runOrchestratorCapability()
// with a mocked @elizaos/ui client and asserts each id routes to the correct
// client method with the correctly coerced params, that required-param errors
// throw, that the open-task first-thread fallback works, and that wrapper-shaped
// results ({paused}/{resumed}/{deleted}/{stopped}/{sent}) are returned.
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = {
  getOrchestratorStatus: vi.fn(),
  listCodingAgentTaskThreads: vi.fn(),
  getCodingAgentTaskThread: vi.fn(),
  createOrchestratorTask: vi.fn(),
  pauseOrchestratorTask: vi.fn(),
  resumeOrchestratorTask: vi.fn(),
  pauseAllOrchestratorTasks: vi.fn(),
  resumeAllOrchestratorTasks: vi.fn(),
  deleteOrchestratorTask: vi.fn(),
  forkOrchestratorTask: vi.fn(),
  updateOrchestratorTask: vi.fn(),
  validateOrchestratorTask: vi.fn(),
  addOrchestratorAgent: vi.fn(),
  stopOrchestratorAgent: vi.fn(),
  postOrchestratorTaskMessage: vi.fn(),
};

vi.mock("@elizaos/ui", () => ({
  client: new Proxy(
    {},
    {
      get(_t, prop: string) {
        const fn = (m as Record<string, ReturnType<typeof vi.fn>>)[prop];
        if (!fn) throw new Error(`unexpected client method: ${prop}`);
        return (...args: unknown[]) => fn(...args);
      },
    },
  ),
}));

import {
  ORCHESTRATOR_CAPABILITY_IDS,
  runOrchestratorCapability,
} from "../../src/orchestrator-capabilities";

beforeEach(() => {
  for (const fn of Object.values(m)) fn.mockReset();
  m.getOrchestratorStatus.mockResolvedValue({ taskCount: 2 });
  m.listCodingAgentTaskThreads.mockResolvedValue([]);
  m.getCodingAgentTaskThread.mockResolvedValue({ id: "task-1" });
  m.createOrchestratorTask.mockResolvedValue({ id: "new" });
  m.pauseOrchestratorTask.mockResolvedValue(true);
  m.resumeOrchestratorTask.mockResolvedValue(true);
  m.pauseAllOrchestratorTasks.mockResolvedValue(4);
  m.resumeAllOrchestratorTasks.mockResolvedValue(3);
  m.deleteOrchestratorTask.mockResolvedValue(true);
  m.forkOrchestratorTask.mockResolvedValue({ id: "forked" });
  m.updateOrchestratorTask.mockResolvedValue({ id: "task-1" });
  m.validateOrchestratorTask.mockResolvedValue({ ok: true });
  m.addOrchestratorAgent.mockResolvedValue({ sessionId: "s1" });
  m.stopOrchestratorAgent.mockResolvedValue(true);
  m.postOrchestratorTaskMessage.mockResolvedValue(true);
});

describe("ORCHESTRATOR_CAPABILITY_IDS", () => {
  it("contains exactly the 15 documented capability ids", () => {
    expect([...ORCHESTRATOR_CAPABILITY_IDS].sort()).toEqual(
      [
        "orchestrator-add-agent",
        "orchestrator-create-task",
        "orchestrator-delete-task",
        "orchestrator-fork-task",
        "orchestrator-list-tasks",
        "orchestrator-open-task",
        "orchestrator-pause-all",
        "orchestrator-pause-task",
        "orchestrator-resume-all",
        "orchestrator-resume-task",
        "orchestrator-send-message",
        "orchestrator-status",
        "orchestrator-stop-agent",
        "orchestrator-update-task",
        "orchestrator-validate-task",
      ].sort(),
    );
    expect(ORCHESTRATOR_CAPABILITY_IDS.size).toBe(15);
  });
});

describe("orchestrator-status", () => {
  it("returns getOrchestratorStatus()", async () => {
    const out = await runOrchestratorCapability("orchestrator-status");
    expect(m.getOrchestratorStatus).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ taskCount: 2 });
  });
});

describe("orchestrator-list-tasks", () => {
  it("defaults limit to 100, coerces status/search, includeArchived only when true", async () => {
    await runOrchestratorCapability("orchestrator-list-tasks", {
      status: "  active ",
      search: "  ",
      includeArchived: "true",
    });
    expect(m.listCodingAgentTaskThreads).toHaveBeenCalledWith({
      includeArchived: false,
      status: "active",
      search: undefined,
      limit: 100,
    });
  });

  it("honors a numeric limit and includeArchived:true", async () => {
    await runOrchestratorCapability("orchestrator-list-tasks", {
      includeArchived: true,
      limit: 10,
    });
    expect(m.listCodingAgentTaskThreads).toHaveBeenLastCalledWith({
      includeArchived: true,
      status: undefined,
      search: undefined,
      limit: 10,
    });
  });
});

describe("orchestrator-open-task", () => {
  it("opens the provided taskId directly", async () => {
    m.getCodingAgentTaskThread.mockResolvedValue({ id: "task-9" });
    const out = await runOrchestratorCapability("orchestrator-open-task", {
      taskId: " task-9 ",
    });
    expect(m.getCodingAgentTaskThread).toHaveBeenCalledWith("task-9");
    expect(m.listCodingAgentTaskThreads).not.toHaveBeenCalled();
    expect(out).toEqual({ id: "task-9" });
  });

  it("falls back to the first listed thread when no taskId is supplied", async () => {
    m.listCodingAgentTaskThreads.mockResolvedValue([{ id: "first" }]);
    m.getCodingAgentTaskThread.mockResolvedValue({ id: "first" });
    const out = await runOrchestratorCapability("orchestrator-open-task");
    expect(m.listCodingAgentTaskThreads).toHaveBeenCalledWith({ limit: 1 });
    expect(m.getCodingAgentTaskThread).toHaveBeenCalledWith("first");
    expect(out).toEqual({ id: "first" });
  });

  it("returns null when there is no first thread", async () => {
    m.listCodingAgentTaskThreads.mockResolvedValue([]);
    const out = await runOrchestratorCapability("orchestrator-open-task");
    expect(out).toBeNull();
    expect(m.getCodingAgentTaskThread).not.toHaveBeenCalled();
  });
});

describe("orchestrator-create-task", () => {
  it("throws when title or goal is missing", async () => {
    await expect(
      runOrchestratorCapability("orchestrator-create-task", { title: "x" }),
    ).rejects.toThrow(/title and goal are required/);
    await expect(
      runOrchestratorCapability("orchestrator-create-task", { goal: "y" }),
    ).rejects.toThrow(/title and goal are required/);
  });

  it("forwards title/goal plus coerced priority + acceptanceCriteria", async () => {
    await runOrchestratorCapability("orchestrator-create-task", {
      title: "  Build it ",
      goal: " Ship the feature ",
      originalRequest: " please ",
      kind: " coding ",
      priority: "high",
      acceptanceCriteria: [" tests pass ", "", 1, "lint clean"],
    });
    expect(m.createOrchestratorTask).toHaveBeenCalledWith({
      title: "Build it",
      goal: "Ship the feature",
      originalRequest: "please",
      kind: "coding",
      priority: "high",
      acceptanceCriteria: ["tests pass", "lint clean"],
    });
  });

  it("drops an invalid priority to undefined", async () => {
    await runOrchestratorCapability("orchestrator-create-task", {
      title: "t",
      goal: "g",
      priority: "medium",
    });
    expect(m.createOrchestratorTask).toHaveBeenCalledWith(
      expect.objectContaining({ priority: undefined }),
    );
  });
});

describe("orchestrator pause/resume/delete (requireTaskId)", () => {
  it("pause-task forwards the trimmed taskId", async () => {
    await runOrchestratorCapability("orchestrator-pause-task", {
      taskId: " t1 ",
    });
    expect(m.pauseOrchestratorTask).toHaveBeenCalledWith("t1");
  });

  it("resume-task forwards the trimmed taskId", async () => {
    await runOrchestratorCapability("orchestrator-resume-task", {
      taskId: "t2",
    });
    expect(m.resumeOrchestratorTask).toHaveBeenCalledWith("t2");
  });

  it("delete-task wraps the boolean result as {deleted}", async () => {
    const out = await runOrchestratorCapability("orchestrator-delete-task", {
      taskId: "t3",
    });
    expect(m.deleteOrchestratorTask).toHaveBeenCalledWith("t3");
    expect(out).toEqual({ deleted: true });
  });

  it("throws requireTaskId for a taskId-bearing capability with no id", async () => {
    await expect(
      runOrchestratorCapability("orchestrator-pause-task", {}),
    ).rejects.toThrow(/taskId is required/);
    await expect(
      runOrchestratorCapability("orchestrator-delete-task", { taskId: " " }),
    ).rejects.toThrow(/taskId is required/);
  });
});

describe("orchestrator pause-all / resume-all", () => {
  it("pause-all wraps the count as {paused}", async () => {
    m.pauseAllOrchestratorTasks.mockResolvedValue(7);
    const out = await runOrchestratorCapability("orchestrator-pause-all");
    expect(out).toEqual({ paused: 7 });
  });

  it("resume-all wraps the count as {resumed}", async () => {
    m.resumeAllOrchestratorTasks.mockResolvedValue(2);
    const out = await runOrchestratorCapability("orchestrator-resume-all");
    expect(out).toEqual({ resumed: 2 });
  });
});

describe("orchestrator-fork-task", () => {
  it("forwards requireTaskId + coerced fork fields", async () => {
    await runOrchestratorCapability("orchestrator-fork-task", {
      taskId: "t4",
      title: " Forked ",
      goal: " new goal ",
      priority: "urgent",
      acceptanceCriteria: ["a", ""],
    });
    expect(m.forkOrchestratorTask).toHaveBeenCalledWith("t4", {
      title: "Forked",
      goal: "new goal",
      priority: "urgent",
      acceptanceCriteria: ["a"],
    });
  });
});

describe("orchestrator-update-task", () => {
  it("forwards requireTaskId + coerced update fields", async () => {
    await runOrchestratorCapability("orchestrator-update-task", {
      taskId: "t5",
      title: " New title ",
      summary: " a summary ",
      priority: "low",
      acceptanceCriteria: [" keep ", 2],
      goal: undefined,
    });
    expect(m.updateOrchestratorTask).toHaveBeenCalledWith("t5", {
      title: "New title",
      goal: undefined,
      summary: "a summary",
      priority: "low",
      acceptanceCriteria: ["keep"],
    });
  });
});

describe("orchestrator-validate-task", () => {
  it("throws unless passed is a boolean", async () => {
    await expect(
      runOrchestratorCapability("orchestrator-validate-task", {
        taskId: "t6",
        passed: "true",
      }),
    ).rejects.toThrow(/passed \(boolean\) is required/);
  });

  it("forwards the verdict with humanOverride only when strictly true", async () => {
    await runOrchestratorCapability("orchestrator-validate-task", {
      taskId: "t6",
      passed: false,
      summary: " no ",
      evidence: " log ",
      verifier: " ci ",
      humanOverride: "yes",
    });
    expect(m.validateOrchestratorTask).toHaveBeenCalledWith("t6", {
      passed: false,
      summary: "no",
      evidence: "log",
      verifier: "ci",
      humanOverride: false,
    });
  });
});

describe("orchestrator-add-agent", () => {
  it("forwards requireTaskId + coerced agent fields", async () => {
    await runOrchestratorCapability("orchestrator-add-agent", {
      taskId: "t7",
      framework: " codex ",
      providerSource: " openai ",
      model: " gpt-5.5 ",
      workdir: " /repo ",
      repo: " owner/repo ",
      label: " worker ",
      task: " do it ",
    });
    expect(m.addOrchestratorAgent).toHaveBeenCalledWith("t7", {
      framework: "codex",
      providerSource: "openai",
      model: "gpt-5.5",
      workdir: "/repo",
      repo: "owner/repo",
      label: "worker",
      task: "do it",
    });
  });
});

describe("orchestrator-stop-agent", () => {
  it("throws without a sessionId", async () => {
    await expect(
      runOrchestratorCapability("orchestrator-stop-agent", { taskId: "t8" }),
    ).rejects.toThrow(/sessionId is required/);
  });

  it("wraps the result as {stopped} when both ids are present", async () => {
    const out = await runOrchestratorCapability("orchestrator-stop-agent", {
      taskId: "t8",
      sessionId: " s-9 ",
    });
    expect(m.stopOrchestratorAgent).toHaveBeenCalledWith("t8", "s-9");
    expect(out).toEqual({ stopped: true });
  });
});

describe("orchestrator-send-message", () => {
  it("throws without content", async () => {
    await expect(
      runOrchestratorCapability("orchestrator-send-message", {
        taskId: "t9",
        content: "   ",
      }),
    ).rejects.toThrow(/content is required/);
  });

  it("wraps the result as {sent} with the trimmed content", async () => {
    const out = await runOrchestratorCapability("orchestrator-send-message", {
      taskId: "t9",
      content: " hello there ",
    });
    expect(m.postOrchestratorTaskMessage).toHaveBeenCalledWith(
      "t9",
      "hello there",
    );
    expect(out).toEqual({ sent: true });
  });
});

describe("runOrchestratorCapability: unknown", () => {
  it("throws for an unrecognized capability", async () => {
    await expect(
      runOrchestratorCapability("orchestrator-nope"),
    ).rejects.toThrow(/does not support/);
  });
});
