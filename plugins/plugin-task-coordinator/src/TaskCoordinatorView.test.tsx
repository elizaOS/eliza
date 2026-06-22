// @vitest-environment jsdom
//
// Drives the unified TaskCoordinatorView (the single GUI/XR data wrapper) through
// the rendered DOM — the same component the bundle exports for the "gui", "xr",
// and "tui" modalities. Asserts the on-mount thread fetch, the Open → detail
// drill-down, the show-archived toggle re-fetch, and the Delete (archive) +
// Reopen mutations all reach the client with the right arguments.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listCodingAgentTaskThreads = vi.fn();
const getCodingAgentTaskThread = vi.fn();
const archiveCodingAgentTaskThread = vi.fn();
const reopenCodingAgentTaskThread = vi.fn();

vi.mock("@elizaos/ui", () => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  },
  client: {
    listCodingAgentTaskThreads: (...a: unknown[]) =>
      listCodingAgentTaskThreads(...a),
    getCodingAgentTaskThread: (...a: unknown[]) =>
      getCodingAgentTaskThread(...a),
    archiveCodingAgentTaskThread: (...a: unknown[]) =>
      archiveCodingAgentTaskThread(...a),
    reopenCodingAgentTaskThread: (...a: unknown[]) =>
      reopenCodingAgentTaskThread(...a),
  },
}));

import { TaskCoordinatorView } from "./TaskCoordinatorView";

function makeThread(over: Record<string, unknown>) {
  return {
    id: "t-x",
    title: "Task X",
    kind: "coding",
    status: "active",
    priority: "normal",
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
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
      cacheTokens: 0,
      totalTokens: 0,
      costUsd: 0,
      state: "unavailable",
      byProvider: [],
    },
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
    acceptanceCriteria: ["ships"],
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

const threads = [
  makeThread({ id: "t1", title: "Refactor auth", status: "active" }),
  makeThread({ id: "t2", title: "Fix tests", status: "done" }),
];

function button(agentId: string): HTMLButtonElement {
  const el = document.querySelector(`[data-agent-id="${agentId}"]`);
  if (!el) throw new Error(`no element with data-agent-id="${agentId}"`);
  return el as HTMLButtonElement;
}

beforeEach(() => {
  listCodingAgentTaskThreads.mockResolvedValue(threads);
  getCodingAgentTaskThread.mockImplementation(async (id: string) =>
    makeDetail({ id, title: "Refactor auth", status: "active" }),
  );
  archiveCodingAgentTaskThread.mockResolvedValue(true);
  reopenCodingAgentTaskThread.mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TaskCoordinatorView — unified GUI/XR/TUI wrapper", () => {
  it("fetches the thread list on mount and renders the rows", async () => {
    render(React.createElement(TaskCoordinatorView));
    await screen.findByText("Refactor auth");
    expect(listCodingAgentTaskThreads).toHaveBeenCalledWith({
      includeArchived: false,
      search: undefined,
      limit: 30,
    });
    expect(screen.getByText("Fix tests")).toBeTruthy();
  });

  it("opens a thread's detail when its Open button is clicked", async () => {
    render(React.createElement(TaskCoordinatorView));
    await screen.findByText("Refactor auth");
    fireEvent.click(button("open-t1"));
    await waitFor(() =>
      expect(getCodingAgentTaskThread).toHaveBeenCalledWith("t1"),
    );
    await screen.findByText("ships"); // acceptance criterion in detail
  });

  it("re-fetches with includeArchived when show-archived is toggled", async () => {
    render(React.createElement(TaskCoordinatorView));
    await screen.findByText("Refactor auth");
    listCodingAgentTaskThreads.mockClear();
    fireEvent.click(button("toggle-archived"));
    await waitFor(() =>
      expect(listCodingAgentTaskThreads).toHaveBeenCalledWith({
        includeArchived: true,
        search: undefined,
        limit: 30,
      }),
    );
  });

  it("archives the open thread when Delete is clicked", async () => {
    render(React.createElement(TaskCoordinatorView));
    await screen.findByText("Refactor auth");
    fireEvent.click(button("open-t1"));
    await screen.findByText("ships");
    fireEvent.click(button("delete-thread"));
    await waitFor(() =>
      expect(archiveCodingAgentTaskThread).toHaveBeenCalledWith("t1"),
    );
  });

  it("reopens the open thread when Reopen is clicked on an archived task", async () => {
    getCodingAgentTaskThread.mockImplementation(async (id: string) =>
      makeDetail({ id, title: "Refactor auth", status: "archived" }),
    );
    render(React.createElement(TaskCoordinatorView));
    await screen.findByText("Refactor auth");
    fireEvent.click(button("open-t1"));
    await screen.findByText("ships");
    fireEvent.click(button("reopen-thread"));
    await waitFor(() =>
      expect(reopenCodingAgentTaskThread).toHaveBeenCalledWith("t1"),
    );
  });

  it("renders the error banner when the thread fetch rejects", async () => {
    listCodingAgentTaskThreads.mockRejectedValue(new Error("boom"));
    render(React.createElement(TaskCoordinatorView));
    await screen.findByText("boom");
  });
});
