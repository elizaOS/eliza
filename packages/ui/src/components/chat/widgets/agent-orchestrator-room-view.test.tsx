// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type {
  CodingAgentOrchestratorStatus,
  OrchestratorRoomRosterOverview,
} from "../../../api/client-types-cloud";
import {
  OrchestratorRoomView,
  OrchestratorRoomViewSkeleton,
} from "./agent-orchestrator-room-view";

afterEach(cleanup);

const status: CodingAgentOrchestratorStatus = {
  taskCount: 3,
  activeTaskCount: 2,
  pausedTaskCount: 0,
  blockedTaskCount: 0,
  validatingTaskCount: 1,
  sessionCount: 4,
  activeSessionCount: 3,
  usage: {
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    state: "measured",
    byProvider: [],
  },
  byStatus: {} as CodingAgentOrchestratorStatus["byStatus"],
};

const rooms: OrchestratorRoomRosterOverview = {
  rooms: [
    {
      taskId: "task-parser",
      taskTitle: "Refactor the parser",
      status: "active",
      roomId: "room-1",
      activeAgentCount: 2,
      multiParty: true,
      participants: [
        { kind: "orchestrator", id: "orchestrator", label: "Orchestrator" },
        { kind: "user", id: "owner", label: "You" },
        {
          kind: "sub_agent",
          id: "s1",
          label: "Ada",
          framework: "claude",
          status: "tool_running",
          active: true,
          activeTool: "edit_file",
          totalTokens: 48200,
          usageState: "measured",
        },
        {
          kind: "sub_agent",
          id: "s2",
          label: "Mara",
          framework: "opencode",
          status: "stopped",
          active: false,
          totalTokens: 6100,
          usageState: "estimated",
        },
      ],
    },
    {
      taskId: "task-done",
      taskTitle: "Already shipped",
      status: "done",
      roomId: "room-2",
      activeAgentCount: 0,
      multiParty: false,
      participants: [
        { kind: "orchestrator", id: "orchestrator", label: "Orchestrator" },
      ],
    },
  ],
};

describe("OrchestratorRoomView", () => {
  it("renders a friendly empty state with a hint when there are no live rooms", () => {
    render(<OrchestratorRoomView rooms={{ rooms: [] }} />);
    // The section frame still renders (never null), so the title is present.
    expect(screen.getByTestId("chat-widget-rooms")).toBeTruthy();
    expect(screen.getByText("No active coding tasks")).toBeTruthy();
    expect(
      screen.getByText(
        "ask me to build something or spawn a sub-agent to see live task rooms here.",
      ),
    ).toBeTruthy();
  });

  it("shows the live task/agent status line even with zero rooms", () => {
    render(<OrchestratorRoomView rooms={{ rooms: [] }} status={status} />);
    const line = screen.getByTestId("orchestrator-room-status-line");
    // activeTaskCount + activeSessionCount surface so the system reads as alive.
    expect(within(line).getByText("2")).toBeTruthy();
    expect(within(line).getByText("3")).toBeTruthy();
    expect(within(line).getByText("tasks")).toBeTruthy();
    expect(within(line).getByText("agents")).toBeTruthy();
  });

  it("surfaces a subtle stale hint (not a crash) when a refresh failed", () => {
    render(<OrchestratorRoomView rooms={{ rooms: [] }} staleHint />);
    expect(
      screen.getByText("couldn't refresh, showing last known"),
    ).toBeTruthy();
  });

  it("renders the skeleton inside the section frame, never a blank gap", () => {
    render(<OrchestratorRoomViewSkeleton />);
    expect(screen.getByTestId("chat-widget-rooms")).toBeTruthy();
    expect(screen.getByTestId("orchestrator-room-skeleton")).toBeTruthy();
  });

  it("hides terminal (done/failed/archived) rooms from the live board", () => {
    render(<OrchestratorRoomView rooms={rooms} />);
    const cards = screen.getAllByTestId("orchestrator-room-card");
    // The "done" room is filtered out, only the active room remains.
    expect(cards).toHaveLength(1);
    expect(screen.getByText("Refactor the parser")).toBeTruthy();
    expect(screen.queryByText("Already shipped")).toBeNull();
  });

  it("renders the swarm with the active tool surfaced and the live count", () => {
    render(<OrchestratorRoomView rooms={rooms} />);
    const card = screen.getByTestId("orchestrator-room-card");
    // Active tool of the running sub-agent is surfaced.
    expect(within(card).getByText("edit_file")).toBeTruthy();
    // Both sub-agents render plus the two anchors.
    expect(within(card).getByText("Ada")).toBeTruthy();
    expect(within(card).getByText("Mara")).toBeTruthy();
    expect(within(card).getByText("Orchestrator")).toBeTruthy();
    expect(within(card).getByText("You")).toBeTruthy();
    // Header total reflects the one live room's active agent count.
    expect(screen.getByText("2 live")).toBeTruthy();
  });

  it("orders live sub-agents ahead of idle ones", () => {
    render(<OrchestratorRoomView rooms={rooms} />);
    const card = screen.getByTestId("orchestrator-room-card");
    const rows = within(card).getAllByTestId("room-participant");
    const labels = rows.map((row) => row.textContent ?? "");
    const adaIdx = labels.findIndex((l) => l.includes("Ada"));
    const maraIdx = labels.findIndex((l) => l.includes("Mara"));
    // Ada is live (tool_running), Mara is stopped, so Ada must sort first.
    expect(adaIdx).toBeLessThan(maraIdx);
  });
});
