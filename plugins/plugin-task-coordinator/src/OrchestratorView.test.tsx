// @vitest-environment jsdom
//
// Drives the unified OrchestratorView (the single GUI/XR data wrapper) through
// the rendered DOM — the same component the bundle exports for the "gui", "xr",
// and "tui" modalities. Asserts the on-mount status + thread fetch, the
// Open → detail drill-down, and the pause/validate/restart/archive/priority
// onAction wiring all reach the client with the right arguments.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getOrchestratorStatus = vi.fn();
const listCodingAgentTaskThreads = vi.fn();
const getCodingAgentTaskThread = vi.fn();
const pauseOrchestratorTask = vi.fn();
const resumeOrchestratorTask = vi.fn();
const validateOrchestratorTask = vi.fn();
const forkOrchestratorTask = vi.fn();
const restartOrchestratorTask = vi.fn();
const deleteOrchestratorTask = vi.fn();
const archiveCodingAgentTaskThread = vi.fn();
const reopenCodingAgentTaskThread = vi.fn();
const updateOrchestratorTask = vi.fn();
const pauseAllOrchestratorTasks = vi.fn();
const resumeAllOrchestratorTasks = vi.fn();
const stopOrchestratorAgent = vi.fn();

vi.mock("@elizaos/ui", () => ({
  client: {
    getOrchestratorStatus: (...a: unknown[]) => getOrchestratorStatus(...a),
    listCodingAgentTaskThreads: (...a: unknown[]) =>
      listCodingAgentTaskThreads(...a),
    getCodingAgentTaskThread: (...a: unknown[]) =>
      getCodingAgentTaskThread(...a),
    pauseOrchestratorTask: (...a: unknown[]) => pauseOrchestratorTask(...a),
    resumeOrchestratorTask: (...a: unknown[]) => resumeOrchestratorTask(...a),
    validateOrchestratorTask: (...a: unknown[]) =>
      validateOrchestratorTask(...a),
    forkOrchestratorTask: (...a: unknown[]) => forkOrchestratorTask(...a),
    restartOrchestratorTask: (...a: unknown[]) => restartOrchestratorTask(...a),
    deleteOrchestratorTask: (...a: unknown[]) => deleteOrchestratorTask(...a),
    archiveCodingAgentTaskThread: (...a: unknown[]) =>
      archiveCodingAgentTaskThread(...a),
    reopenCodingAgentTaskThread: (...a: unknown[]) =>
      reopenCodingAgentTaskThread(...a),
    updateOrchestratorTask: (...a: unknown[]) => updateOrchestratorTask(...a),
    pauseAllOrchestratorTasks: (...a: unknown[]) =>
      pauseAllOrchestratorTasks(...a),
    resumeAllOrchestratorTasks: (...a: unknown[]) =>
      resumeAllOrchestratorTasks(...a),
    stopOrchestratorAgent: (...a: unknown[]) => stopOrchestratorAgent(...a),
  },
}));

import { OrchestratorView } from "./OrchestratorView";

const usage = {
  inputTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  cacheTokens: 0,
  totalTokens: 0,
  costUsd: 0,
  state: "measured" as const,
  byProvider: [],
};

function makeThread(over: Record<string, unknown>) {
  return {
    id: "t-x",
    title: "Task X",
    kind: "coding",
    status: "active",
    priority: "high",
    paused: false,
    originalRequest: "do the thing",
    summary: "",
    sessionCount: 1,
    activeSessionCount: 1,
    latestSessionId: null,
    latestSessionLabel: null,
    latestWorkdir: null,
    latestRepo: null,
    latestActivityAt: null,
    decisionCount: 0,
    usage,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    closedAt: null,
    archivedAt: null,
    ...over,
  };
}

function makeDetail(over: Record<string, unknown>) {
  return {
    ...makeThread(over),
    goal: "the goal",
    roomId: null,
    taskRoomId: null,
    worldId: null,
    ownerUserId: null,
    parentTaskId: null,
    acceptanceCriteria: [],
    currentPlan: null,
    providerPolicy: null,
    lastUserTurnAt: null,
    lastCoordinatorTurnAt: null,
    metadata: {},
    sessions: [],
    decisions: [],
    events: [],
    artifacts: [],
    messages: [],
    transcripts: [],
    planRevisions: [],
    ...over,
  };
}

const status = {
  taskCount: 2,
  activeTaskCount: 1,
  pausedTaskCount: 0,
  blockedTaskCount: 0,
  validatingTaskCount: 0,
  sessionCount: 1,
  activeSessionCount: 1,
  usage,
  byStatus: {
    open: 0,
    active: 1,
    waiting_on_user: 0,
    blocked: 0,
    validating: 0,
    done: 1,
    failed: 0,
    archived: 0,
    interrupted: 0,
  },
};

const threads = [
  makeThread({ id: "t1", title: "Refactor auth", status: "active" }),
  makeThread({ id: "t2", title: "Fix tests", status: "done" }),
];

function button(agentId: string): HTMLButtonElement {
  const el = document.querySelector(`[data-agent-id="${agentId}"]`);
  if (!el) throw new Error(`no element with data-agent-id="${agentId}"`);
  return el as HTMLButtonElement;
}

async function openTask1() {
  fireEvent.click(button("open-t1"));
  await waitFor(() =>
    expect(getCodingAgentTaskThread).toHaveBeenCalledWith("t1"),
  );
  await screen.findByText("the goal"); // detail goal renders
}

beforeEach(() => {
  getOrchestratorStatus.mockResolvedValue(status);
  listCodingAgentTaskThreads.mockResolvedValue(threads);
  getCodingAgentTaskThread.mockImplementation(async (id: string) =>
    makeDetail({ id, title: "Refactor auth", status: "active", paused: false }),
  );
  for (const fn of [
    pauseOrchestratorTask,
    resumeOrchestratorTask,
    validateOrchestratorTask,
    forkOrchestratorTask,
    restartOrchestratorTask,
    updateOrchestratorTask,
  ]) {
    fn.mockResolvedValue(makeDetail({ id: "t1" }));
  }
  deleteOrchestratorTask.mockResolvedValue(true);
  archiveCodingAgentTaskThread.mockResolvedValue(true);
  reopenCodingAgentTaskThread.mockResolvedValue(true);
  pauseAllOrchestratorTasks.mockResolvedValue(1);
  resumeAllOrchestratorTasks.mockResolvedValue(1);
  stopOrchestratorAgent.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("OrchestratorView — unified GUI/XR/TUI wrapper", () => {
  it("fetches status + threads on mount and renders the rows", async () => {
    render(React.createElement(OrchestratorView));
    await screen.findByText("Refactor auth");
    expect(getOrchestratorStatus).toHaveBeenCalled();
    expect(listCodingAgentTaskThreads).toHaveBeenCalledWith({ limit: 30 });
    expect(screen.getByText("Fix tests")).toBeTruthy();
  });

  it("opens a task's detail when its Open button is clicked", async () => {
    render(React.createElement(OrchestratorView));
    await screen.findByText("Refactor auth");
    await openTask1();
  });

  it("pauses the open task via the Pause action", async () => {
    render(React.createElement(OrchestratorView));
    await screen.findByText("Refactor auth");
    await openTask1();
    fireEvent.click(button("pause"));
    await waitFor(() =>
      expect(pauseOrchestratorTask).toHaveBeenCalledWith("t1"),
    );
  });

  it("validates the open task via the Validate action", async () => {
    render(React.createElement(OrchestratorView));
    await screen.findByText("Refactor auth");
    await openTask1();
    fireEvent.click(button("validate"));
    await waitFor(() =>
      expect(validateOrchestratorTask).toHaveBeenCalledWith("t1", {
        passed: true,
      }),
    );
  });

  it("restarts the open task via the Restart action", async () => {
    render(React.createElement(OrchestratorView));
    await screen.findByText("Refactor auth");
    await openTask1();
    fireEvent.click(button("restart"));
    await waitFor(() =>
      expect(restartOrchestratorTask).toHaveBeenCalledWith("t1"),
    );
  });

  it("archives the open task via the Archive action", async () => {
    render(React.createElement(OrchestratorView));
    await screen.findByText("Refactor auth");
    await openTask1();
    fireEvent.click(button("archive"));
    await waitFor(() =>
      expect(archiveCodingAgentTaskThread).toHaveBeenCalledWith("t1"),
    );
  });

  it("updates priority via the priority select", async () => {
    render(React.createElement(OrchestratorView));
    await screen.findByText("Refactor auth");
    await openTask1();
    const select = document.querySelector(
      '[data-agent-id="priority"]',
    ) as HTMLSelectElement;
    expect(select).toBeTruthy();
    fireEvent.change(select, { target: { value: "urgent" } });
    await waitFor(() =>
      expect(updateOrchestratorTask).toHaveBeenCalledWith("t1", {
        priority: "urgent",
      }),
    );
  });

  it("pauses all tasks via the list Pause all action", async () => {
    render(React.createElement(OrchestratorView));
    await screen.findByText("Refactor auth");
    fireEvent.click(button("pause-all"));
    await waitFor(() => expect(pauseAllOrchestratorTasks).toHaveBeenCalled());
  });
});
