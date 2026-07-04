// @vitest-environment jsdom
//
// Interaction tests for CockpitView: it renders the live room-deck from the
// roster prop and the spawn form, and surfaces select/create callbacks.
// Deterministic RTL/jsdom, no network.
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { OrchestratorRoomRosterOverview } from "../../api/client-types-cloud";
import { CockpitView } from "./CockpitView";

afterEach(cleanup);

const ROSTER: OrchestratorRoomRosterOverview = {
  rooms: [
    {
      taskId: "t1",
      taskTitle: "Fix the auth tests",
      status: "active",
      activeAgentCount: 1,
      multiParty: false,
      participants: [
        { kind: "orchestrator", id: "o1", label: "Eliza", active: true },
        {
          kind: "sub_agent",
          id: "a1",
          label: "claude-1",
          framework: "claude",
          status: "running",
          active: true,
        },
      ],
    },
  ],
};

describe("CockpitView", () => {
  it("renders the deck and the new-session form", () => {
    render(<CockpitView rooms={ROSTER} onCreateSession={vi.fn()} />);
    expect(screen.getByTestId("cockpit-view")).toBeTruthy();
    expect(screen.getByTestId("cockpit-deck")).toBeTruthy();
    expect(screen.getByTestId("cockpit-new-session-form")).toBeTruthy();
    // a room card from the deck
    expect(screen.getByText("Fix the auth tests")).toBeTruthy();
  });

  it("shows the deck empty-state when there are no live rooms", () => {
    render(<CockpitView rooms={{ rooms: [] }} onCreateSession={vi.fn()} />);
    expect(screen.getByTestId("cockpit-deck")).toBeTruthy();
    // form is still available so you can start the first session
    expect(screen.getByTestId("cockpit-new-session-form")).toBeTruthy();
  });

  it("surfaces an error when provided", () => {
    render(<CockpitView rooms={null} onCreateSession={vi.fn()} error="boom" />);
    expect(screen.getByTestId("cockpit-error").textContent).toContain("boom");
  });

  it("drills into a room when onSelectRoom is provided", async () => {
    const user = userEvent.setup();
    const onSelectRoom = vi.fn();
    render(
      <CockpitView
        rooms={ROSTER}
        onCreateSession={vi.fn()}
        onSelectRoom={onSelectRoom}
      />,
    );
    await user.click(screen.getByTestId("orchestrator-room-open"));
    expect(onSelectRoom).toHaveBeenCalledWith("t1");
  });

  it("starting a session calls onCreateSession with a create-task input", async () => {
    const user = userEvent.setup();
    const onCreateSession = vi.fn();
    render(
      <CockpitView rooms={{ rooms: [] }} onCreateSession={onCreateSession} />,
    );
    await user.type(screen.getByTestId("cockpit-goal-input"), "do the thing");
    await user.click(screen.getByTestId("cockpit-start-button"));
    expect(onCreateSession).toHaveBeenCalledTimes(1);
    expect(onCreateSession.mock.calls[0][0]).toMatchObject({
      title: "do the thing",
      goal: "do the thing",
      providerPolicy: {
        preferredFramework: "elizaos",
        providerSource: "eliza-cloud",
      },
    });
  });
});
