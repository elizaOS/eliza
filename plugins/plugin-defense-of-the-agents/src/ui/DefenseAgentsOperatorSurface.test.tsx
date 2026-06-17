// @vitest-environment jsdom

import type ReactTypes from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFENSE_APP_NAME,
  makeDefenseRun,
  makeDefenseSession,
  makeDefenseTelemetry,
} from "./test-support";

const sendAppRunMessage = vi.hoisted(() => vi.fn());
const setState = vi.hoisted(() => vi.fn());
const appState = vi.hoisted(() => ({
  appRuns: [] as Array<Record<string, unknown>>,
  setState,
  setActionNotice: vi.fn(),
}));

// Faithful-enough GameOperatorShell stub: renders the objective, the detailItems,
// the events the surface passes in, and a button per primary/suggested action
// wired to the real onCommand handler so the test can drive sendCommand and
// assert what the surface forwarded (primary action labels/commands/testIds,
// event list + cleanDefenseMessage rewrites, suggested-action slicing, canSend).
const GameOperatorShell = vi.hoisted(
  () =>
    function GameOperatorShellMock(props: {
      surfaceTestId: string;
      objective: string | null;
      detailItems: Array<{ label: string; value: string }>;
      events: Array<{ id: string; label: string; message: string }>;
      primaryActions: Array<{
        id: string;
        label: string;
        command: string;
        testId?: string;
      }>;
      suggestedActions: Array<{
        id: string;
        label: string;
        command: string;
        testId?: string;
      }>;
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
          { "data-testid": "shell-detail-items" },
          props.detailItems.map((item) =>
            React.createElement(
              "div",
              { key: item.label, "data-detail-label": item.label },
              `${item.label}: ${item.value}`,
            ),
          ),
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
              "data-testid": action.testId,
              "data-primary-action": action.id,
              "data-command": action.command,
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
              "data-testid": action.testId,
              "data-suggested-action": action.id,
              "data-command": action.command,
              onClick: () => props.onCommand(action.command),
            },
            action.label,
          ),
        ),
      );
    },
);

const uiCompatMock = vi.hoisted(() => ({
  client: { sendAppRunMessage },
  useApp: () => appState,
  GameOperatorShell,
}));

vi.mock("@elizaos/app-core/ui-compat", () => uiCompatMock);
vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

const { render, screen, fireEvent, waitFor, cleanup } = await import(
  "@testing-library/react"
);
const { DefenseAgentsOperatorSurface } = await import(
  "./DefenseAgentsOperatorSurface"
);

// The hero "Recall" CTA is a plain button (no data-primary-action attribute);
// the GameOperatorShell primary recall button carries data-primary-action.
function findRecallCta(): HTMLButtonElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) =>
        button.textContent?.trim() === "Recall" &&
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

describe("DefenseAgentsOperatorSurface — empty state", () => {
  it("renders the empty operator surface with the three static cards", () => {
    render(<DefenseAgentsOperatorSurface appName={DEFENSE_APP_NAME} />);

    expect(screen.getByTestId("defense-operator-empty")).toBeTruthy();
    expect(screen.getByText("Deploys on launch")).toBeTruthy();
    expect(screen.getByText("Move · recall · reinforce")).toBeTruthy();
    expect(screen.getByText("Toggle in session")).toBeTruthy();
    expect(screen.getByText("Waiting for a match")).toBeTruthy();
    // No GameOperatorShell rendered when there is no run.
    expect(screen.queryByTestId("defense-detail-operator-surface")).toBeNull();
  });
});

describe("DefenseAgentsOperatorSurface — populated data", () => {
  it("renders the hero line, mode/relay status strip, and status chip", () => {
    appState.appRuns = [makeDefenseRun()];
    render(<DefenseAgentsOperatorSurface appName={DEFENSE_APP_NAME} />);

    // formatHeroLine(telemetry) → "Mage Lv3 mid, 80/100 HP" in the status strip
    // card, and as a GameOperatorShell detailItem ("Hero: ...").
    expect(screen.getByText("Mage Lv3 mid, 80/100 HP")).toBeTruthy();
    expect(screen.getByText("Hero: Mage Lv3 mid, 80/100 HP")).toBeTruthy();
    // Mode card: autoPlay true → "Autoplay".
    expect(screen.getAllByText("Autoplay").length).toBeGreaterThan(0);
    // Relay card: canSend true → "Ready".
    expect(screen.getByText("Ready")).toBeTruthy();
    // status "running" → statusLabel "Live" (chip + shell statusLabel).
    expect(screen.getAllByText("Live").length).toBeGreaterThan(0);
    // GameOperatorShell objective = session.goalLabel.
    expect(screen.getByTestId("shell-objective").textContent).toBe(
      "Mage holding mid lane",
    );
    expect(screen.getByTestId("defense-detail-operator-surface")).toBeTruthy();
  });

  it("uses the live surface test id when variant is live", () => {
    appState.appRuns = [makeDefenseRun()];
    render(
      <DefenseAgentsOperatorSurface
        appName={DEFENSE_APP_NAME}
        variant="live"
      />,
    );
    expect(screen.getByTestId("defense-live-operator-surface")).toBeTruthy();
  });

  it("derives the autoplay/recall/lane primary actions with testIds and commands", () => {
    appState.appRuns = [makeDefenseRun()];
    render(<DefenseAgentsOperatorSurface appName={DEFENSE_APP_NAME} />);

    // autoPlay true → label "Autoplay on", command flips to "Auto-play OFF".
    const autoplay = screen.getByTestId("defense-command-autoplay");
    expect(autoplay.getAttribute("data-command")).toBe("Auto-play OFF");
    expect(autoplay.textContent).toBe("Autoplay on");

    const recall = screen.getByTestId("defense-command-recall");
    expect(recall.getAttribute("data-command")).toBe("Recall to base");

    // heroLane = "mid" → label "Move mid", command "Move to mid lane".
    const lane = screen.getByTestId("defense-command-lane-mid");
    expect(lane.textContent).toBe("Move mid");
    expect(lane.getAttribute("data-command")).toBe("Move to mid lane");
  });

  it("renders the autoplay-off command label when autoPlay is false", () => {
    appState.appRuns = [
      makeDefenseRun({
        session: makeDefenseSession({
          telemetry: makeDefenseTelemetry({ autoPlay: false }),
        }),
      }),
    ];
    render(<DefenseAgentsOperatorSurface appName={DEFENSE_APP_NAME} />);

    const autoplay = screen.getByTestId("defense-command-autoplay");
    expect(autoplay.textContent).toBe("Autoplay off");
    // autoPlay false → command flips to "Auto-play ON".
    expect(autoplay.getAttribute("data-command")).toBe("Auto-play ON");
    // Mode card reads "Manual".
    expect(screen.getByText("Manual")).toBeTruthy();
  });

  it("derives a deploy-mid lane action when no hero lane is present", () => {
    appState.appRuns = [
      makeDefenseRun({
        session: makeDefenseSession({
          telemetry: makeDefenseTelemetry({
            heroLane: null,
            heroClass: "mage",
          }),
        }),
      }),
    ];
    render(<DefenseAgentsOperatorSurface appName={DEFENSE_APP_NAME} />);

    const lane = screen.getByTestId("defense-command-lane-mid");
    expect(lane.textContent).toBe("Deploy mid");
    expect(lane.getAttribute("data-command")).toBe(
      "Deploy as mage in mid lane",
    );
  });

  it("derives a Move-top lane action for a top-lane hero", () => {
    appState.appRuns = [
      makeDefenseRun({
        session: makeDefenseSession({
          telemetry: makeDefenseTelemetry({ heroLane: "top" }),
        }),
      }),
    ];
    render(<DefenseAgentsOperatorSurface appName={DEFENSE_APP_NAME} />);

    const lane = screen.getByTestId("defense-command-lane-top");
    expect(lane.textContent).toBe("Move top");
    expect(lane.getAttribute("data-command")).toBe("Move to top lane");
  });

  it("shows Syncing relay state and no recall CTA when commands are unavailable", () => {
    appState.appRuns = [
      makeDefenseRun({
        session: makeDefenseSession({ canSendCommands: false }),
      }),
    ];
    render(<DefenseAgentsOperatorSurface appName={DEFENSE_APP_NAME} />);

    expect(screen.getByText("Syncing")).toBeTruthy();
    // The hero CTA is gated on canSend; the primary recall button still renders.
    expect(findRecallCta()).toBeNull();
    expect(screen.getByTestId("defense-command-recall")).toBeTruthy();
  });

  it("limits suggested actions to the two relevant prompts (autoplay excluded)", () => {
    appState.appRuns = [
      makeDefenseRun({
        session: makeDefenseSession({
          suggestedPrompts: [
            "Auto-play OFF", // excluded: auto-play
            "Move to top lane", // relevant
            "Recall to base", // relevant
            "Reinforce bot lane", // relevant but sliced off (3rd)
            "Something irrelevant", // excluded: not a relevant prompt
          ],
        }),
      }),
    ];
    render(<DefenseAgentsOperatorSurface appName={DEFENSE_APP_NAME} />);

    const suggested = document.querySelectorAll("[data-suggested-action]");
    expect(suggested.length).toBe(2);
    expect(screen.getByText("Move to top lane")).toBeTruthy();
    // "Recall to base" also appears as the primary recall CTA, so assert via
    // the suggested-action attribute set.
    const suggestedCommands = Array.from(suggested).map((node) =>
      node.getAttribute("data-command"),
    );
    expect(suggestedCommands).toEqual(["Move to top lane", "Recall to base"]);
    // The 3rd relevant prompt is sliced off.
    expect(screen.queryByText("Reinforce bot lane")).toBeNull();
    expect(screen.queryByText("Something irrelevant")).toBeNull();
  });
});

describe("DefenseAgentsOperatorSurface — events feed + cleanDefenseMessage", () => {
  it("filters refresh/attach/detach events and rewrites known error messages", () => {
    appState.appRuns = [
      makeDefenseRun({
        recentEvents: [
          {
            eventId: "ev-refresh",
            kind: "refresh",
            severity: "info",
            message: "should be filtered",
            createdAt: "2026-05-19T00:00:00.000Z",
          },
          {
            eventId: "ev-429",
            kind: "status",
            severity: "warning",
            message: "Too many requests (429)",
            createdAt: "2026-05-19T00:00:01.000Z",
          },
          {
            eventId: "ev-fetch",
            kind: "status",
            severity: "error",
            message: "Failed to fetch game state for game 3.",
            createdAt: "2026-05-19T00:00:02.000Z",
          },
          {
            eventId: "ev-control",
            kind: "status",
            severity: "error",
            message: "Defense control API unavailable: boom",
            createdAt: "2026-05-19T00:00:03.000Z",
          },
        ],
        session: makeDefenseSession({
          telemetry: makeDefenseTelemetry({ recentActivity: [] }),
        }),
      }),
    ];
    render(<DefenseAgentsOperatorSurface appName={DEFENSE_APP_NAME} />);

    const ids = Array.from(document.querySelectorAll("[data-event-id]")).map(
      (node) => node.getAttribute("data-event-id"),
    );
    // refresh filtered; capped at 3 (slice(0,3)).
    expect(ids).not.toContain("ev-refresh");
    expect(ids).toEqual(["ev-429", "ev-fetch", "ev-control"]);

    // cleanDefenseMessage rewrites.
    expect(
      screen.getByText(
        "status: Defense controls are rate-limited right now. Try again shortly.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "status: Defense state is temporarily unavailable. Retrying automatically.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText("status: Defense controls are temporarily unavailable."),
    ).toBeTruthy();
  });

  it("surfaces telemetry recentActivity details in the events feed", () => {
    appState.appRuns = [
      makeDefenseRun({
        session: makeDefenseSession({
          telemetry: makeDefenseTelemetry({
            recentActivity: [
              {
                ts: 1_700_000_000_000,
                action: "command",
                detail: "Learned Fireball",
              },
            ],
          }),
        }),
      }),
    ];
    render(<DefenseAgentsOperatorSurface appName={DEFENSE_APP_NAME} />);
    expect(screen.getByText("command: Learned Fireball")).toBeTruthy();
  });
});

describe("DefenseAgentsOperatorSurface — sendCommand behavior", () => {
  it("sends Recall via the hero CTA and clears local events on a persisted session", async () => {
    sendAppRunMessage.mockResolvedValue({
      success: true,
      message: "Recalling.",
      disposition: "accepted",
      run: makeDefenseRun(),
      session: makeDefenseSession(),
    });
    appState.appRuns = [makeDefenseRun()];
    render(<DefenseAgentsOperatorSurface appName={DEFENSE_APP_NAME} />);

    const cta = findRecallCta();
    expect(cta).not.toBeNull();
    fireEvent.click(cta as HTMLButtonElement);

    await waitFor(() =>
      expect(sendAppRunMessage).toHaveBeenCalledWith(
        "defense-run",
        "Recall to base",
      ),
    );
    // response.run present → persisted via setState.
    await waitFor(() =>
      expect(setState).toHaveBeenCalledWith("appRuns", expect.any(Array)),
    );
  });

  it("sends the flipped autoplay command and shows the optimistic You event", async () => {
    sendAppRunMessage.mockResolvedValue({
      success: true,
      message: "Auto-play disabled.",
      disposition: "queued",
      run: null,
      session: null,
    });
    appState.appRuns = [makeDefenseRun()];
    render(<DefenseAgentsOperatorSurface appName={DEFENSE_APP_NAME} />);

    fireEvent.click(screen.getByTestId("defense-command-autoplay"));

    // autoPlay true → command "Auto-play OFF".
    await waitFor(() =>
      expect(sendAppRunMessage).toHaveBeenCalledWith(
        "defense-run",
        "Auto-play OFF",
      ),
    );
    // Optimistic "You" event appears with the command text.
    await waitFor(() =>
      expect(screen.getByText("You: Auto-play OFF")).toBeTruthy(),
    );
    // queued disposition (no persisted session) → "Queued" labelled event.
    await waitFor(() =>
      expect(screen.getByText("Queued: Auto-play disabled.")).toBeTruthy(),
    );
  });

  it("records an Error local event when the send rejects", async () => {
    sendAppRunMessage.mockRejectedValue(new Error("backend offline"));
    appState.appRuns = [makeDefenseRun()];
    render(<DefenseAgentsOperatorSurface appName={DEFENSE_APP_NAME} />);

    fireEvent.click(screen.getByTestId("defense-command-recall"));

    await waitFor(() =>
      expect(screen.getByText("Error: backend offline")).toBeTruthy(),
    );
  });

  it("guards against concurrent sends while a command is in flight", async () => {
    let resolveSend: ((value: unknown) => void) | null = null;
    sendAppRunMessage.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSend = resolve;
        }),
    );
    appState.appRuns = [makeDefenseRun()];
    render(<DefenseAgentsOperatorSurface appName={DEFENSE_APP_NAME} />);

    const recall = screen.getByTestId("defense-command-recall");
    fireEvent.click(recall);
    await waitFor(() => expect(sendAppRunMessage).toHaveBeenCalledTimes(1));
    // Second click while sending must be a no-op (sendingCommand guard).
    fireEvent.click(recall);
    fireEvent.click(screen.getByTestId("defense-command-autoplay"));
    expect(sendAppRunMessage).toHaveBeenCalledTimes(1);

    // Release the in-flight send so the test exits cleanly.
    resolveSend?.({ success: true, message: "ok", run: null, session: null });
    await waitFor(() =>
      expect(screen.queryByText("You: Recall to base")).toBeTruthy(),
    );
  });
});
