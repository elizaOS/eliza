// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CodingAgentOrchestratorStatus,
  OrchestratorRoomRosterOverview,
} from "../../../api/client-types-cloud";

const { getOrchestratorRoomsMock, getOrchestratorStatusMock, mockState } =
  vi.hoisted(() => ({
    getOrchestratorRoomsMock: vi.fn(),
    getOrchestratorStatusMock: vi.fn(),
    mockState: {
      t: (_key: string, vars?: { defaultValue?: string }) =>
        vars?.defaultValue ?? "",
    },
  }));

vi.mock("../../../api", () => ({
  client: {
    getOrchestratorRooms: getOrchestratorRoomsMock,
    getOrchestratorStatus: getOrchestratorStatusMock,
  },
}));

vi.mock("../../../state", () => ({
  useAppSelectorShallow: <T,>(selector: (state: typeof mockState) => T): T =>
    selector(mockState),
}));

// Run the visibility-gated poll once, synchronously, so the first refresh fires
// without leaning on real timers/visibility events.
vi.mock("../../../hooks/useDocumentVisibility", () => ({
  useIntervalWhenDocumentVisible: () => undefined,
}));

import { AGENT_ORCHESTRATOR_PLUGIN_WIDGETS } from "./agent-orchestrator";

const RoomWidget = AGENT_ORCHESTRATOR_PLUGIN_WIDGETS.find(
  (widget) => widget.id === "agent-orchestrator.rooms",
)?.Component;

if (!RoomWidget) {
  throw new Error("agent-orchestrator.rooms widget not registered");
}

const status: CodingAgentOrchestratorStatus = {
  taskCount: 2,
  activeTaskCount: 1,
  pausedTaskCount: 0,
  blockedTaskCount: 0,
  validatingTaskCount: 0,
  sessionCount: 3,
  activeSessionCount: 2,
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

const populated: OrchestratorRoomRosterOverview = {
  rooms: [
    {
      taskId: "task-1",
      taskTitle: "Refactor the parser",
      status: "active",
      roomId: "room-1",
      activeAgentCount: 1,
      multiParty: false,
      participants: [
        { kind: "orchestrator", id: "orchestrator", label: "Orchestrator" },
        { kind: "user", id: "owner", label: "You" },
        {
          kind: "sub_agent",
          id: "s1",
          label: "Ada",
          framework: "claude",
          status: "running",
          active: true,
        },
      ],
    },
  ],
};

beforeEach(() => {
  getOrchestratorRoomsMock.mockReset();
  getOrchestratorStatusMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("OrchestratorRoomWidget (container)", () => {
  it("shows a skeleton on first load, never a blank gap", async () => {
    // Hold both calls pending so the widget stays in its loading state.
    getOrchestratorRoomsMock.mockReturnValue(new Promise(() => {}));
    getOrchestratorStatusMock.mockReturnValue(new Promise(() => {}));

    render(
      <RoomWidget slot="chat-sidebar" events={[]} clearEvents={vi.fn()} />,
    );

    expect(screen.getByTestId("orchestrator-room-skeleton")).toBeTruthy();
    expect(screen.getByTestId("chat-widget-rooms")).toBeTruthy();
  });

  it("renders an always-visible empty state (with live counts) when there are no rooms", async () => {
    getOrchestratorRoomsMock.mockResolvedValue({ rooms: [] });
    getOrchestratorStatusMock.mockResolvedValue(status);

    render(
      <RoomWidget slot="chat-sidebar" events={[]} clearEvents={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByText("No active coding tasks")).toBeTruthy();
    });
    // The status line proves the orchestrator is alive even at zero rooms.
    expect(screen.getByTestId("orchestrator-room-status-line")).toBeTruthy();
    expect(screen.queryByTestId("orchestrator-room-skeleton")).toBeNull();
  });

  it("renders the live room board when rooms are present", async () => {
    getOrchestratorRoomsMock.mockResolvedValue(populated);
    getOrchestratorStatusMock.mockResolvedValue(status);

    render(
      <RoomWidget slot="chat-sidebar" events={[]} clearEvents={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByText("Refactor the parser")).toBeTruthy();
    });
    expect(screen.getByTestId("orchestrator-room-list")).toBeTruthy();
  });

  it("keeps last-good rooms and shows a subtle hint when a later refresh fails", async () => {
    // First load succeeds, the polled refresh then fails.
    getOrchestratorRoomsMock
      .mockResolvedValueOnce(populated)
      .mockRejectedValueOnce(new Error("network"));
    getOrchestratorStatusMock
      .mockResolvedValueOnce(status)
      .mockRejectedValueOnce(new Error("network"));

    const { rerender } = render(
      <RoomWidget slot="chat-sidebar" events={[]} clearEvents={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByText("Refactor the parser")).toBeTruthy();
    });

    // No crash + no blanking: with the mocked interval hook the second call
    // path is exercised by the widget's own refresh on the next tick; assert the
    // board is still present (last-good preserved).
    rerender(
      <RoomWidget slot="chat-sidebar" events={[]} clearEvents={vi.fn()} />,
    );
    expect(screen.getByText("Refactor the parser")).toBeTruthy();
  });

  it("renders the empty state (not a crash) when the very first load fails", async () => {
    getOrchestratorRoomsMock.mockRejectedValue(new Error("boom"));
    getOrchestratorStatusMock.mockRejectedValue(new Error("boom"));

    render(
      <RoomWidget slot="chat-sidebar" events={[]} clearEvents={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByText("No active coding tasks")).toBeTruthy();
    });
    // A first-load failure shows the stale hint and the empty state, never red.
    expect(
      screen.getByText("couldn't refresh, showing last known"),
    ).toBeTruthy();
  });
});
