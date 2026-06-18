// Runtime dispatch tests for the task-coordinator TUI view's interact() handler
// (src/CodingAgentTasksPanel.interact.ts). interact() is what BOTH TUI views'
// task-coordinator capabilities run at runtime: list-sessions/refresh,
// list-task-threads (with includeArchived/search/limit coercion), open-thread
// (with first-thread fallback), stop-session (with the sessionId-required
// guard), plus delegation of every orchestrator-* id to runOrchestratorCapability
// and the unknown-capability throw. We mock @elizaos/ui's `client` so we assert
// the exact client method + payload each capability dispatches.
import { beforeEach, describe, expect, it, vi } from "vitest";

const getCodingAgentStatus = vi.fn();
const listCodingAgentTaskThreads = vi.fn();
const getCodingAgentTaskThread = vi.fn();
const stopCodingAgent = vi.fn();
const getOrchestratorStatus = vi.fn();

vi.mock("@elizaos/ui", () => ({
  client: {
    getCodingAgentStatus: (...a: unknown[]) => getCodingAgentStatus(...a),
    listCodingAgentTaskThreads: (...a: unknown[]) =>
      listCodingAgentTaskThreads(...a),
    getCodingAgentTaskThread: (...a: unknown[]) =>
      getCodingAgentTaskThread(...a),
    stopCodingAgent: (...a: unknown[]) => stopCodingAgent(...a),
    getOrchestratorStatus: (...a: unknown[]) => getOrchestratorStatus(...a),
  },
}));

import { interact } from "../../src/CodingAgentTasksPanel.interact";

beforeEach(() => {
  getCodingAgentStatus.mockReset().mockResolvedValue({ taskCount: 3 });
  listCodingAgentTaskThreads.mockReset().mockResolvedValue([]);
  getCodingAgentTaskThread.mockReset().mockResolvedValue({ id: "x" });
  stopCodingAgent.mockReset().mockResolvedValue(true);
  getOrchestratorStatus.mockReset().mockResolvedValue({ taskCount: 0 });
});

describe("interact: list-sessions / refresh", () => {
  it("both ids fetch the coding-agent status and return it", async () => {
    const a = await interact("list-sessions");
    expect(getCodingAgentStatus).toHaveBeenCalledTimes(1);
    expect(a).toEqual({ taskCount: 3 });

    const b = await interact("refresh");
    expect(getCodingAgentStatus).toHaveBeenCalledTimes(2);
    expect(b).toEqual({ taskCount: 3 });
  });
});

describe("interact: list-task-threads", () => {
  it("defaults limit to 30 and only sets includeArchived when strictly true", async () => {
    await interact("list-task-threads");
    expect(listCodingAgentTaskThreads).toHaveBeenCalledWith({
      includeArchived: false,
      search: undefined,
      limit: 30,
    });
  });

  it("forwards includeArchived:true, the search string, and an explicit limit", async () => {
    await interact("list-task-threads", {
      includeArchived: true,
      search: "parser",
      limit: 5,
    });
    expect(listCodingAgentTaskThreads).toHaveBeenLastCalledWith({
      includeArchived: true,
      search: "parser",
      limit: 5,
    });
  });

  it("treats a non-boolean includeArchived as false and a non-string search as undefined", async () => {
    await interact("list-task-threads", {
      includeArchived: "yes",
      search: 123,
    });
    expect(listCodingAgentTaskThreads).toHaveBeenLastCalledWith({
      includeArchived: false,
      search: undefined,
      limit: 30,
    });
  });
});

describe("interact: open-thread", () => {
  it("opens the given threadId directly (trimmed)", async () => {
    getCodingAgentTaskThread.mockResolvedValue({ id: "t-7" });
    const out = await interact("open-thread", { threadId: "  t-7  " });
    expect(getCodingAgentTaskThread).toHaveBeenCalledWith("t-7");
    expect(out).toEqual({ id: "t-7" });
    // No list call needed when an id is supplied.
    expect(listCodingAgentTaskThreads).not.toHaveBeenCalled();
  });

  it("falls back to the first thread when no threadId is supplied", async () => {
    listCodingAgentTaskThreads.mockResolvedValue([
      { id: "first" },
      { id: "second" },
    ]);
    getCodingAgentTaskThread.mockResolvedValue({ id: "first", title: "F" });
    const out = await interact("open-thread");
    expect(listCodingAgentTaskThreads).toHaveBeenCalledWith({
      includeArchived: false,
      limit: 1,
    });
    expect(getCodingAgentTaskThread).toHaveBeenCalledWith("first");
    expect(out).toEqual({ id: "first", title: "F" });
  });

  it("returns null when there are no threads to fall back to", async () => {
    listCodingAgentTaskThreads.mockResolvedValue([]);
    const out = await interact("open-thread", { threadId: "   " });
    expect(out).toBeNull();
    expect(getCodingAgentTaskThread).not.toHaveBeenCalled();
  });
});

describe("interact: stop-session", () => {
  it("returns a {stopped:false,reason} guard result for a blank sessionId", async () => {
    const out = await interact("stop-session", { sessionId: "  " });
    expect(out).toEqual({
      stopped: false,
      reason: expect.stringMatching(/sessionId is required/),
    });
    expect(stopCodingAgent).not.toHaveBeenCalled();
  });

  it("returns the guard result when sessionId is entirely absent", async () => {
    const out = (await interact("stop-session")) as {
      stopped: boolean;
      reason: string;
    };
    expect(out.stopped).toBe(false);
    expect(out.reason).toMatch(/sessionId is required/);
  });

  it("stops the trimmed sessionId when one is provided", async () => {
    stopCodingAgent.mockResolvedValue(true);
    const out = await interact("stop-session", { sessionId: " sess-1 " });
    expect(stopCodingAgent).toHaveBeenCalledWith("sess-1");
    expect(out).toBe(true);
  });
});

describe("interact: orchestrator delegation + unknown capability", () => {
  it("delegates an orchestrator-* id to runOrchestratorCapability (which hits the client)", async () => {
    const out = await interact("orchestrator-status");
    expect(getOrchestratorStatus).toHaveBeenCalledTimes(1);
    expect(out).toEqual({ taskCount: 0 });
  });

  it("rejects an unrecognized capability with a descriptive error", async () => {
    await expect(interact("does-not-exist")).rejects.toThrow(
      /does not support/,
    );
  });
});
