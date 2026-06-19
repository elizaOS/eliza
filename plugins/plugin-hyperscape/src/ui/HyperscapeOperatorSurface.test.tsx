// @vitest-environment jsdom

import type ReactTypes from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HYPERSCAPE_APP_NAME,
  makeHyperscapeRun,
  makeHyperscapeSession,
} from "./test-support";

const sendAppRunMessage = vi.hoisted(() => vi.fn());
const controlAppRun = vi.hoisted(() => vi.fn());
const appState = vi.hoisted(() => ({
  appRuns: [] as Array<Record<string, unknown>>,
  setActionNotice: vi.fn(),
  setState: vi.fn(),
}));

// Faithful-enough passthrough stubs that render their content + label so the
// tests can assert the real values the surface places into each card/section.
const passthrough = vi.hoisted(
  () =>
    function passthroughFactory(testid: string) {
      return function PassthroughStub(props: {
        label?: string;
        value?: string;
        subtitle?: string;
        title?: string;
        children?: ReactTypes.ReactNode;
      }) {
        const React = require("react") as typeof ReactTypes;
        return React.createElement(
          "div",
          { "data-stub": testid },
          props.label !== undefined
            ? React.createElement(
                "span",
                { "data-stub-label": props.label },
                props.label,
              )
            : null,
          props.title !== undefined
            ? React.createElement(
                "span",
                { "data-stub-title": props.title },
                props.title,
              )
            : null,
          props.value !== undefined
            ? React.createElement(
                "span",
                { "data-stub-value": props.value },
                props.value,
              )
            : null,
          props.subtitle !== undefined
            ? React.createElement(
                "span",
                { "data-stub-subtitle": props.subtitle },
                props.subtitle,
              )
            : null,
          props.children,
        );
      };
    },
);

function latestRunForApp(
  appName: string,
  appRuns: Array<Record<string, unknown>>,
) {
  const matchingRuns = appRuns.filter((run) => run.appName === appName);
  return { run: matchingRuns[0] ?? null, matchingRuns };
}

const uiCompatMock = vi.hoisted(() => ({
  client: { sendAppRunMessage, controlAppRun },
  useApp: () => appState,
  selectLatestRunForApp: latestRunForApp,
  SurfaceBadge: passthrough("SurfaceBadge"),
  SurfaceCard: passthrough("SurfaceCard"),
  SurfaceSection: passthrough("SurfaceSection"),
  formatDetailTimestamp: (value: unknown) =>
    value == null ? "" : `ts:${String(value)}`,
  toneForHealthState: () => "neutral",
  toneForStatusText: () => "neutral",
  toneForViewerAttachment: () => "neutral",
}));

vi.mock("@elizaos/app-core/ui-compat", () => uiCompatMock);

// Button comes from @elizaos/ui; useAgentElement from @elizaos/ui/agent-surface,
// which the vitest config collapses onto @elizaos/ui.
vi.mock("@elizaos/ui", () => ({
  Button: (props: ReactTypes.ButtonHTMLAttributes<HTMLButtonElement>) => {
    const React = require("react") as typeof ReactTypes;
    return React.createElement(
      "button",
      { type: "button", ...props },
      props.children,
    );
  },
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

const { render, screen, fireEvent, waitFor, cleanup } = await import(
  "@testing-library/react"
);
const { HyperscapeOperatorSurface } = await import(
  "./HyperscapeOperatorSurface"
);

// Find a SurfaceCard stub by its label and return its rendered value text.
function cardValue(label: string): string | null {
  const labelNode = document.querySelector(`[data-stub-label="${label}"]`);
  const card = labelNode?.closest('[data-stub="SurfaceCard"]');
  return (
    card?.querySelector("[data-stub-value]")?.getAttribute("data-stub-value") ??
    null
  );
}

function cardSubtitle(label: string): string | null {
  const labelNode = document.querySelector(`[data-stub-label="${label}"]`);
  const card = labelNode?.closest('[data-stub="SurfaceCard"]');
  return (
    card
      ?.querySelector("[data-stub-subtitle]")
      ?.getAttribute("data-stub-subtitle") ?? null
  );
}

// The hero CTA shares its label with the first suggested prompt but is a plain
// <button> (no aria-label and not the SurfaceSection-wrapped relay buttons).
function findHeroCta(label: string): HTMLButtonElement | null {
  return (
    Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(
      (button) =>
        button.textContent?.trim() === label &&
        button.getAttribute("aria-label") === null,
    ) ?? null
  );
}

beforeEach(() => {
  appState.appRuns = [];
  sendAppRunMessage.mockReset();
  controlAppRun.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("HyperscapeOperatorSurface (GUI / XR)", () => {
  it("renders the empty operator-ready state when no run exists", () => {
    render(<HyperscapeOperatorSurface appName={HYPERSCAPE_APP_NAME} />);

    expect(screen.getByTestId("hyperscape-operator-ready")).toBeTruthy();
    expect(screen.getByText("Host surface ready")).toBeTruthy();
    // Empty-state status strip cards (Auth attention, Viewer + Follow idle).
    expect(screen.getByText("Wallet pending")).toBeTruthy();
    expect(screen.getByText("Embed attaches")).toBeTruthy();
    expect(screen.getByText("Target sync")).toBeTruthy();
    // Waiting zone copy.
    expect(screen.getByText("Waiting for a host session")).toBeTruthy();
    expect(
      screen.getByText(
        "Launch Hyperscape to attach the viewer and follow the agent.",
      ),
    ).toBeTruthy();
  });

  it("renders the populated 4-card status strip from run + session values", () => {
    appState.appRuns = [makeHyperscapeRun()];
    render(<HyperscapeOperatorSurface appName={HYPERSCAPE_APP_NAME} />);

    // Status strip cards render their VALUES (not just labels):
    // Viewer = run.viewerAttachment "attached".
    expect(screen.getAllByText("attached").length).toBeGreaterThan(0);
    // Follow = session.followEntity.
    expect(screen.getAllByText("milady-character").length).toBeGreaterThan(0);
    // Health = run.health.state.
    expect(screen.getAllByText("healthy").length).toBeGreaterThan(0);
    // Relay = canSendCommands → "Ready".
    expect(screen.getAllByText("Ready").length).toBeGreaterThan(0);
  });

  it("renders the Host + State SurfaceCards with derived values and subtitles", () => {
    appState.appRuns = [makeHyperscapeRun()];
    render(<HyperscapeOperatorSurface appName={HYPERSCAPE_APP_NAME} />);

    // Auth = formatViewerAuthLabel(run): authMessage.type present → "Auto-login HYPERSCAPE_AUTH".
    expect(cardValue("Auth")).toBe("Auto-login HYPERSCAPE_AUTH");
    // Runtime card: supportsBackground true → "Background".
    expect(cardValue("Runtime")).toBe("Background");
    // Goal card reads session.goalLabel verbatim.
    expect(cardValue("Goal")).toBe("Explore the northern district");
    // Follow card value + characterId subtitle.
    expect(cardValue("Follow")).toBe("milady-character");
    expect(cardSubtitle("Follow")).toBe("milady-character");
    // Relay card subtitle = sessionId.
    expect(cardValue("Relay")).toBe("Ready");
    expect(cardSubtitle("Relay")).toBe("hyper-agent-1");
  });

  it("uses the default detail surface test id and the live test id per variant", () => {
    appState.appRuns = [makeHyperscapeRun()];
    const { rerender } = render(
      <HyperscapeOperatorSurface appName={HYPERSCAPE_APP_NAME} />,
    );
    expect(
      screen.getByTestId("hyperscape-detail-operator-surface"),
    ).toBeTruthy();

    rerender(
      <HyperscapeOperatorSurface
        appName={HYPERSCAPE_APP_NAME}
        variant="live"
      />,
    );
    expect(screen.getByTestId("hyperscape-live-operator-surface")).toBeTruthy();
  });

  it("renders recentActivity rows (max 2) and the placeholder when empty", () => {
    appState.appRuns = [
      makeHyperscapeRun({
        recentEvents: [
          {
            eventId: "ev-1",
            kind: "status",
            severity: "info",
            message: "Reached the plaza",
            createdAt: "2026-05-19T00:00:03.000Z",
          },
          {
            eventId: "ev-2",
            kind: "summary",
            severity: "info",
            message: "Greeted the merchant",
            createdAt: "2026-05-19T00:00:02.000Z",
          },
          {
            eventId: "ev-3",
            kind: "health",
            severity: "info",
            message: "third row sliced off",
            createdAt: "2026-05-19T00:00:01.000Z",
          },
        ],
      }),
    ];
    render(<HyperscapeOperatorSurface appName={HYPERSCAPE_APP_NAME} />);

    expect(screen.getByText("Reached the plaza")).toBeTruthy();
    expect(screen.getByText("Greeted the merchant")).toBeTruthy();
    // sorted newest-first then slice(0,2) drops the oldest.
    expect(screen.queryByText("third row sliced off")).toBeNull();
    expect(screen.queryByText("No activity.")).toBeNull();
  });

  it("renders the No activity. placeholder when there is no activity", () => {
    appState.appRuns = [makeHyperscapeRun({ recentEvents: [] })];
    render(<HyperscapeOperatorSurface appName={HYPERSCAPE_APP_NAME} />);
    expect(screen.getByText("No activity.")).toBeTruthy();
  });

  it("relays the hero CTA (first suggested prompt) via sendAppRunMessage and shows the status message", async () => {
    sendAppRunMessage.mockResolvedValue({
      success: true,
      message: "Relayed to Hyperscape.",
    });
    appState.appRuns = [makeHyperscapeRun()];
    render(<HyperscapeOperatorSurface appName={HYPERSCAPE_APP_NAME} />);

    const cta = findHeroCta("look around");
    expect(cta).not.toBeNull();
    fireEvent.click(cta as HTMLButtonElement);

    await waitFor(() =>
      expect(sendAppRunMessage).toHaveBeenCalledWith(
        "hyper-run",
        "look around",
      ),
    );
    await waitFor(() =>
      expect(screen.getByText("Relayed to Hyperscape.")).toBeTruthy(),
    );
  });

  it("relays a suggested-prompt relay button (slice 0,2) via sendAppRunMessage", async () => {
    sendAppRunMessage.mockResolvedValue({ success: true, message: "ok" });
    appState.appRuns = [makeHyperscapeRun()];
    render(<HyperscapeOperatorSurface appName={HYPERSCAPE_APP_NAME} />);

    // The relay buttons carry aria-label = prompt; the second one is the
    // "follow the merchant" prompt (index 1 of the slice).
    const relayButtons = Array.from(
      document.querySelectorAll<HTMLButtonElement>(
        'button[aria-label="follow the merchant"]',
      ),
    );
    expect(relayButtons.length).toBe(1);
    fireEvent.click(relayButtons[0]);

    await waitFor(() =>
      expect(sendAppRunMessage).toHaveBeenCalledWith(
        "hyper-run",
        "follow the merchant",
      ),
    );
    // The third prompt is sliced off (only 2 relay buttons rendered).
    expect(
      document.querySelector('button[aria-label="head to the plaza"]'),
    ).toBeNull();
  });

  it("renders + drives the Pause button only when controls include pause", async () => {
    controlAppRun.mockResolvedValue({ success: true, message: "Paused." });
    appState.appRuns = [
      makeHyperscapeRun({
        session: makeHyperscapeSession({ controls: ["pause"] }),
      }),
    ];
    render(<HyperscapeOperatorSurface appName={HYPERSCAPE_APP_NAME} />);

    const pause = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Pause autonomy"]',
    );
    expect(pause).not.toBeNull();
    // Resume is not rendered (controls only has "pause").
    expect(
      document.querySelector('button[aria-label="Resume autonomy"]'),
    ).toBeNull();
    expect(pause?.textContent).toBe("Pause");

    fireEvent.click(pause as HTMLButtonElement);
    await waitFor(() =>
      expect(controlAppRun).toHaveBeenCalledWith("hyper-run", "pause"),
    );
    await waitFor(() => expect(screen.getByText("Paused.")).toBeTruthy());
  });

  it("renders + drives the Resume button only when controls include resume", async () => {
    controlAppRun.mockResolvedValue({ success: true, message: "Resumed." });
    appState.appRuns = [
      makeHyperscapeRun({
        session: makeHyperscapeSession({ controls: ["resume"] }),
      }),
    ];
    render(<HyperscapeOperatorSurface appName={HYPERSCAPE_APP_NAME} />);

    const resume = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Resume autonomy"]',
    );
    expect(resume).not.toBeNull();
    expect(
      document.querySelector('button[aria-label="Pause autonomy"]'),
    ).toBeNull();
    expect(resume?.textContent).toBe("Resume");

    fireEvent.click(resume as HTMLButtonElement);
    await waitFor(() =>
      expect(controlAppRun).toHaveBeenCalledWith("hyper-run", "resume"),
    );
    await waitFor(() => expect(screen.getByText("Resumed.")).toBeTruthy());
  });

  it("shows the error message in the status region when a send rejects", async () => {
    sendAppRunMessage.mockRejectedValue(new Error("relay offline"));
    appState.appRuns = [makeHyperscapeRun()];
    render(<HyperscapeOperatorSurface appName={HYPERSCAPE_APP_NAME} />);

    fireEvent.click(findHeroCta("look around") as HTMLButtonElement);
    await waitFor(() => expect(screen.getByText("relay offline")).toBeTruthy());
  });

  it("hides the dashboard sections when focus is chat", () => {
    appState.appRuns = [makeHyperscapeRun()];
    render(
      <HyperscapeOperatorSurface appName={HYPERSCAPE_APP_NAME} focus="chat" />,
    );

    // Host/State SurfaceCards (Auth/Goal) are gated on showDashboard (focus !== chat).
    expect(document.querySelector('[data-stub-label="Auth"]')).toBeNull();
    expect(document.querySelector('[data-stub-label="Goal"]')).toBeNull();
    // Operator Relay (showChat) still renders → relay buttons present.
    expect(
      document.querySelector('button[aria-label="look around"]'),
    ).toBeTruthy();
  });

  it("hides the operator relay controls when focus is dashboard", () => {
    appState.appRuns = [makeHyperscapeRun()];
    render(
      <HyperscapeOperatorSurface
        appName={HYPERSCAPE_APP_NAME}
        focus="dashboard"
      />,
    );

    // showChat is false → no relay/pause buttons and no hero CTA.
    expect(
      document.querySelector('button[aria-label="look around"]'),
    ).toBeNull();
    expect(
      document.querySelector('button[aria-label="Pause autonomy"]'),
    ).toBeNull();
    expect(findHeroCta("look around")).toBeNull();
    // Dashboard cards still render.
    expect(cardValue("Goal")).toBe("Explore the northern district");
  });
});
