// @vitest-environment jsdom
//
// OrchestratorRoomView presentation: empty state, hiding terminal rooms from the
// live board, surfacing the active tool + live count, ordering live sub-agents
// ahead of idle ones, and drill-in only when `onSelectRoom` is set. Pure jsdom
// render over fixture props — presentational component, no backend.
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OrchestratorRoomRosterOverview } from "../../../api/client-types-cloud";
import { OrchestratorRoomView } from "./agent-orchestrator-room-view";

afterEach(cleanup);

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
  it("renders an empty state when there are no live rooms", () => {
    render(<OrchestratorRoomView rooms={{ rooms: [] }} />);
    expect(screen.getByText("No active task rooms.")).toBeTruthy();
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

  it("stays presentational (no drill-in button) when onSelectRoom is absent", () => {
    render(<OrchestratorRoomView rooms={rooms} />);
    // back-compat: the chat-sidebar widget passes no callback → plain card.
    expect(screen.queryByTestId("orchestrator-room-open")).toBeNull();
  });

  it("drills into a room when onSelectRoom is set", () => {
    const onSelectRoom = vi.fn();
    render(<OrchestratorRoomView rooms={rooms} onSelectRoom={onSelectRoom} />);
    const open = screen.getByTestId("orchestrator-room-open");
    expect(open.tagName).toBe("BUTTON");
    fireEvent.click(open);
    expect(onSelectRoom).toHaveBeenCalledWith("task-parser");
  });
});
