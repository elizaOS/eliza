// @vitest-environment jsdom

import type ReactTypes from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLAWVILLE_APP_NAME,
  makeClawvilleRun,
  makeClawvilleSession,
} from "./test-support";

const sendAppRunMessage = vi.hoisted(() => vi.fn());
const setState = vi.hoisted(() => vi.fn());
const appState = vi.hoisted(() => ({
  appRuns: [] as Array<Record<string, unknown>>,
  setState,
  setActionNotice: vi.fn(),
}));

// Faithful-enough GameOperatorShell stub: renders the objective, the events the
// surface passes in, and a button per primary/suggested action wired to the
// real onCommand handler so the test can drive sendCommand and assert what the
// surface forwarded (events list, action slicing, canSend gating).
const GameOperatorShell = vi.hoisted(
  () =>
    function GameOperatorShellMock(props: {
      surfaceTestId: string;
      objective: string | null;
      events: Array<{ id: string; label: string; message: string }>;
      primaryActions: Array<{ id: string; label: string; command: string }>;
      suggestedActions: Array<{ id: string; label: string; command: string }>;
      emptyEventsLabel: string;
      canSend: boolean;
      onCommand: (command: string) => void;
    }) {
      const React = require("react") as typeof ReactTypes;
      return React.createElement(
        "div",
        {
          "data-testid": props.surfaceTestId,
          "data-can-send": String(props.canSend),
        },
        React.createElement(
          "div",
          { "data-testid": "shell-objective" },
          props.objective ?? "",
        ),
        React.createElement(
          "div",
          { "data-testid": "shell-events" },
          props.events.length === 0
            ? props.emptyEventsLabel
            : props.events.map((event) =>
                React.createElement(
                  "div",
                  { key: event.id, "data-event-id": event.id },
                  `${event.label}: ${event.message}`,
                ),
              ),
        ),
        props.primaryActions.map((action) =>
          React.createElement(
            "button",
            {
              key: action.id,
              type: "button",
              "data-primary-action": action.id,
              onClick: () => props.onCommand(action.command),
            },
            action.label,
          ),
        ),
        props.suggestedActions.map((action) =>
          React.createElement(
            "button",
            {
              key: action.id,
              type: "button",
              "data-suggested-action": action.id,
              onClick: () => props.onCommand(action.command),
            },
            action.label,
          ),
        ),
      );
    },
);

// The vitest config aliases @elizaos/ui/agent-surface → @elizaos/ui, so a single
// mock of @elizaos/ui also satisfies the agent-surface useAgentElement import.
vi.mock("@elizaos/ui", () => ({
  client: { sendAppRunMessage },
  useApp: () => appState,
  GameOperatorShell,
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

// Imported after the mocks above are registered.
const { render, screen, fireEvent, waitFor, cleanup } = await import(
  "@testing-library/react"
);
const { ClawvilleOperatorSurface } = await import("./ClawvilleOperatorSurface");

// The hero CTA and PRIMARY_COMMANDS[0] share the label "Visit nearest"; the CTA
// is a plain button (no data-primary-action / data-suggested-action attr).
function findHeroCta(): HTMLButtonElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) =>
        button.textContent?.trim() === "Visit nearest" &&
        !button.hasAttribute("data-primary-action") &&
        !button.hasAttribute("data-suggested-action"),
    ) ?? null
  );
}

beforeEach(() => {
  appState.appRuns = [];
  sendAppRunMessage.mockReset();
  setState.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("ClawvilleOperatorSurface (GUI / XR)", () => {
  it("renders the empty state with the quick-action count when no run exists", () => {
    render(<ClawvilleOperatorSurface appName={CLAWVILLE_APP_NAME} />);

    expect(screen.getByTestId("clawville-operator-empty")).toBeTruthy();
    // PRIMARY_COMMANDS has 2 entries.
    expect(screen.getByText("2 quick actions")).toBeTruthy();
    expect(screen.getByText("Waiting for a ClawVille session")).toBeTruthy();
  });

  it("renders populated telemetry (location, goal) and the operator surface", () => {
    appState.appRuns = [makeClawvilleRun()];

    render(<ClawvilleOperatorSurface appName={CLAWVILLE_APP_NAME} />);

    // Location card reads the telemetry nearestBuildingLabel value.
    expect(screen.getAllByText("Krusty Krab").length).toBeGreaterThan(0);
    // Goal card reads session.goalLabel verbatim.
    expect(screen.getByTestId("shell-objective").textContent).toBe(
      "Near Krusty Krab. Visit or ask the local NPC.",
    );
    expect(
      screen.getByTestId("clawville-detail-operator-surface"),
    ).toBeTruthy();
    // canSend telemetry → "Ready" relay card.
    expect(screen.getByText("Ready")).toBeTruthy();
  });

  it("uses the live surface test id when variant is live", () => {
    appState.appRuns = [makeClawvilleRun()];
    render(
      <ClawvilleOperatorSurface appName={CLAWVILLE_APP_NAME} variant="live" />,
    );
    expect(screen.getByTestId("clawville-live-operator-surface")).toBeTruthy();
  });

  it("renders only the first two suggested prompts as suggested actions", () => {
    appState.appRuns = [makeClawvilleRun()];
    render(<ClawvilleOperatorSurface appName={CLAWVILLE_APP_NAME} />);

    const suggested = document.querySelectorAll("[data-suggested-action]");
    expect(suggested.length).toBe(2);
    expect(screen.getByText("Move to tool workshop")).toBeTruthy();
    expect(screen.getByText("Visit the nearest building")).toBeTruthy();
    // The 3rd/4th suggested prompts are sliced off.
    expect(screen.queryByText("Move to skill forge")).toBeNull();
  });

  it("filters refresh/attach/detach events and merges server + activity events (max 3)", () => {
    const run = makeClawvilleRun({
      recentEvents: [
        {
          eventId: "ev-refresh",
          kind: "refresh",
          severity: "info",
          message: "should be filtered",
          createdAt: "2026-04-24T00:00:00.000Z",
        },
        {
          eventId: "ev-status",
          kind: "status",
          severity: "warning",
          message: "Too far from tool-workshop to visit",
          createdAt: "2026-04-24T00:00:01.000Z",
        },
        {
          eventId: "ev-summary",
          kind: "summary",
          severity: "info",
          message: "Explored the reef",
          createdAt: "2026-04-24T00:00:02.000Z",
        },
        {
          eventId: "ev-health",
          kind: "health",
          severity: "info",
          message: "fourth event truncated by slice(0,3)",
          createdAt: "2026-04-24T00:00:03.000Z",
        },
      ],
    });
    appState.appRuns = [run];

    render(<ClawvilleOperatorSurface appName={CLAWVILLE_APP_NAME} />);
    const eventNodes = document.querySelectorAll("[data-event-id]");
    const ids = Array.from(eventNodes).map((n) =>
      n.getAttribute("data-event-id"),
    );

    // refresh filtered out; total capped at 3.
    expect(ids).not.toContain("ev-refresh");
    expect(ids).toEqual(["ev-status", "ev-summary", "ev-health"]);
    // cleanClawvilleMessage rewrites "Too far from <id>" into a friendly label
    // (formatBuildingId title-cases the building id, "-" → spaces).
    expect(
      screen.getByText(
        "status: Too far from Tool Workshop. Move closer before visiting.",
      ),
    ).toBeTruthy();
  });

  it("sends the primary command via the visit-nearest CTA and clears local events on persisted session", async () => {
    sendAppRunMessage.mockResolvedValue({
      success: true,
      message: "Moving.",
      disposition: "accepted",
      status: 200,
      run: makeClawvilleRun(),
      session: makeClawvilleSession(),
    });
    appState.appRuns = [makeClawvilleRun()];

    render(<ClawvilleOperatorSurface appName={CLAWVILLE_APP_NAME} />);
    const cta = findHeroCta();
    expect(cta).not.toBeNull();
    fireEvent.click(cta as HTMLButtonElement);

    await waitFor(() =>
      expect(sendAppRunMessage).toHaveBeenCalledWith(
        "clawville-run",
        "Visit the nearest building",
      ),
    );
    // response.run present → setState("appRuns", ...) is called to persist it.
    await waitFor(() =>
      expect(setState).toHaveBeenCalledWith("appRuns", expect.any(Array)),
    );
  });

  it("maps disposition to a local event when the server returns no persisted session", async () => {
    sendAppRunMessage.mockResolvedValue({
      success: true,
      message: "Command queued.",
      disposition: "queued",
      status: 202,
      run: null,
      session: null,
    });
    appState.appRuns = [makeClawvilleRun()];

    render(<ClawvilleOperatorSurface appName={CLAWVILLE_APP_NAME} />);
    const cta = findHeroCta();
    expect(cta).not.toBeNull();
    fireEvent.click(cta as HTMLButtonElement);

    // Optimistic "You" event appears immediately.
    await waitFor(() =>
      expect(screen.getByText("You: Visit the nearest building")).toBeTruthy(),
    );
    // queued disposition → "Queued" labelled game event with the server message.
    await waitFor(() =>
      expect(screen.getByText("Queued: Command queued.")).toBeTruthy(),
    );
  });

  it("renders a Visit-nearest CTA only when commands can be sent", () => {
    appState.appRuns = [
      makeClawvilleRun({
        session: makeClawvilleSession({ canSendCommands: false }),
      }),
    ];
    render(<ClawvilleOperatorSurface appName={CLAWVILLE_APP_NAME} />);
    // The hero CTA is gated on canSend; the primary-action button still renders.
    expect(findHeroCta()).toBeNull();
    expect(
      document.querySelector('[data-primary-action="visit-nearest"]'),
    ).toBeTruthy();
    // Relay card shows "Syncing" when commands are unavailable.
    expect(screen.getByText("Syncing")).toBeTruthy();
  });
});
