// @vitest-environment jsdom

import type ReactTypes from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildRealScapeSession,
  makeScapeRun,
  SCAPE_APP_NAME,
} from "./test-support";

const sendAppRunMessage = vi.hoisted(() => vi.fn());
const controlAppRun = vi.hoisted(() => vi.fn());
const setState = vi.hoisted(() => vi.fn());
const appState = vi.hoisted(() => ({
  appRuns: [] as Array<Record<string, unknown>>,
  setState,
  setActionNotice: vi.fn(),
}));

function latestRunForApp(
  appName: string,
  appRuns: Array<Record<string, unknown>>,
) {
  const matchingRuns = (Array.isArray(appRuns) ? appRuns : []).filter(
    (run) => run.appName === appName,
  );
  return { run: matchingRuns[0] ?? null, matchingRuns };
}

// Passthrough Surface primitives that render label/value/subtitle/children as
// plain text so the test can assert the ACTUAL telemetry values the component
// computes (HP "8 / 10", "3225, 3265", "Cow (1 tile)", etc.).
const React = (await import("react")).default;

function SurfaceCard(props: {
  label?: string;
  value?: ReactTypes.ReactNode;
  subtitle?: ReactTypes.ReactNode;
}) {
  return React.createElement(
    "div",
    { "data-surface-card": props.label ?? "" },
    React.createElement("span", { "data-card-label": "" }, props.label),
    React.createElement("span", { "data-card-value": "" }, props.value),
    React.createElement("span", { "data-card-subtitle": "" }, props.subtitle),
  );
}
function SurfaceBadge(props: { children?: ReactTypes.ReactNode }) {
  return React.createElement(
    "span",
    { "data-surface-badge": "" },
    props.children,
  );
}
function SurfaceSection(props: {
  title?: string;
  children?: ReactTypes.ReactNode;
}) {
  return React.createElement(
    "section",
    { "data-section": props.title ?? "" },
    React.createElement("h3", null, props.title),
    props.children,
  );
}

const uiMock = {
  client: { sendAppRunMessage, controlAppRun },
  useApp: () => appState,
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
  Button: (props: ReactTypes.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement("button", { type: "button", ...props }, props.children),
  selectLatestRunForApp: latestRunForApp,
  SurfaceCard,
  SurfaceBadge,
  SurfaceSection,
  formatDetailTimestamp: (value: unknown) => `ts(${String(value)})`,
  toneForHealthState: () => "neutral",
  toneForStatusText: () => "neutral",
  toneForViewerAttachment: () => "neutral",
};

vi.mock("@elizaos/app-core/ui-compat", () => uiMock);
vi.mock("@elizaos/ui", () => uiMock);
vi.mock("@elizaos/ui/agent-surface", () => uiMock);

const { render, screen, fireEvent, waitFor, cleanup, within } = await import(
  "@testing-library/react"
);
const { ScapeOperatorSurface } = await import("./ScapeOperatorSurface");

// The session built by the real producer; reused across populated-state tests.
let liveSession: Awaited<ReturnType<typeof buildRealScapeSession>>;
let pausedSession: Awaited<ReturnType<typeof buildRealScapeSession>>;

beforeEach(async () => {
  appState.appRuns = [];
  sendAppRunMessage.mockReset();
  controlAppRun.mockReset();
  setState.mockReset();
  liveSession = await buildRealScapeSession({ status: "connected" });
  pausedSession = await buildRealScapeSession({
    status: "connected",
    paused: true,
  });
});

afterEach(() => {
  cleanup();
});

function cardValue(label: string): string {
  const card = document.querySelector(`[data-surface-card="${label}"]`);
  return card?.querySelector("[data-card-value]")?.textContent?.trim() ?? "";
}
function cardSubtitle(label: string): string {
  const card = document.querySelector(`[data-surface-card="${label}"]`);
  return card?.querySelector("[data-card-subtitle]")?.textContent?.trim() ?? "";
}

describe("ScapeOperatorSurface — EMPTY (no run)", () => {
  it("renders the spawn-ready empty state with the 4 idle chips + disabled CTA", () => {
    render(<ScapeOperatorSurface appName={SCAPE_APP_NAME} />);

    expect(screen.getByTestId("scape-operator-ready")).toBeTruthy();
    // GameSurfaceHero title + statusLabel.
    expect(screen.getByText("'scape")).toBeTruthy();
    expect(screen.getByText("xRSPS spawn ready")).toBeTruthy();
    // The 4 fixed idle StatChips.
    expect(screen.getByText("Token pending")).toBeTruthy();
    expect(screen.getByText("Spawn pending")).toBeTruthy();
    expect(screen.getByText("Goals · memory")).toBeTruthy();
    expect(screen.getByText("xRSPS standby")).toBeTruthy();
    // Disabled "Spawn agent" CTA.
    const cta = screen.getByText("Spawn agent") as HTMLButtonElement;
    expect(cta.disabled).toBe(true);
    // WaitingForSession copy.
    expect(screen.getByText(/Waiting for an xRSPS session/)).toBeTruthy();
    // No live surface rendered.
    expect(screen.queryByTestId("scape-detail-operator-surface")).toBeNull();
  });
});

describe("ScapeOperatorSurface — POPULATED data display", () => {
  beforeEach(() => {
    appState.appRuns = [makeScapeRun(liveSession)];
  });

  it("renders the live hero, header badges, and matching-run count", () => {
    render(<ScapeOperatorSurface appName={SCAPE_APP_NAME} />);

    expect(screen.getByTestId("scape-detail-operator-surface")).toBeTruthy();
    expect(screen.getByText("'scape Operator Surface")).toBeTruthy();
    // statusLabel = `${run.status} · ${run.health.state}` (not paused).
    expect(screen.getByText("running · healthy")).toBeTruthy();
    // Header badges: run status / viewerAttachment / health state.
    const badges = Array.from(
      document.querySelectorAll("[data-surface-badge]"),
    ).map((b) => b.textContent?.trim());
    expect(badges).toContain("running");
    expect(badges).toContain("attached");
    expect(badges).toContain("healthy");
    // matchingRuns count text.
    expect(screen.getByText("1 active run")).toBeTruthy();
  });

  it("renders the Agent section cards with real telemetry values", () => {
    render(<ScapeOperatorSurface appName={SCAPE_APP_NAME} />);

    // Bot SDK connectionLabel + subtitle.
    expect(cardValue("Bot SDK")).toBe("Spawned in xRSPS");
    expect(cardSubtitle("Bot SDK")).toBe("Perception live");
    // Character name + "Combat X · HP h/m · Run e%" subtitle.
    expect(cardValue("Character")).toBe("LumbridgeRanger");
    expect(cardSubtitle("Character")).toBe("Combat 4 · HP 8 / 10 · Run 91%");
    // Location formatPosition + tick subtitle (not in combat).
    expect(cardValue("Location")).toBe("3225, 3265");
    expect(cardSubtitle("Location")).toBe("Tick 128");
    // Operator Goal: none set in this fixture -> "No directive set.".
    expect(cardValue("Operator Goal")).toBe("No directive set.");
  });

  it("renders the live stat strip values (Bot SDK / Agent / Vitals / Goal)", () => {
    render(<ScapeOperatorSurface appName={SCAPE_APP_NAME} />);
    // Bot SDK chip -> "Connected" when connected.
    expect(screen.getByText("Connected")).toBeTruthy();
    // Agent chip -> agent name.
    expect(screen.getAllByText("LumbridgeRanger").length).toBeGreaterThan(0);
    // Vitals chip -> formatHp.
    expect(screen.getAllByText("8 / 10").length).toBeGreaterThan(0);
    // Goal chip -> active goal title.
    expect(screen.getAllByText("Train attack on cows").length).toBeGreaterThan(
      0,
    );
  });

  it("renders the Active Goal section (title, status, source, progress%, notes, updated ts)", () => {
    render(<ScapeOperatorSurface appName={SCAPE_APP_NAME} />);
    const section = document.querySelector(
      '[data-section="Active Goal"]',
    ) as HTMLElement;
    expect(section).toBeTruthy();
    const scoped = within(section);
    expect(scoped.getByText("Train attack on cows")).toBeTruthy();
    expect(scoped.getByText("active")).toBeTruthy();
    expect(scoped.getByText("operator")).toBeTruthy();
    // Math.round(0.25 * 100) = 25%.
    expect(scoped.getByText("25%")).toBeTruthy();
    expect(scoped.getByText(/Stay in the Lumbridge cow field/)).toBeTruthy();
    // formatDetailTimestamp via the mock -> "Updated ts(<updatedAt>)".
    expect(scoped.getByText(/Updated ts\(/)).toBeTruthy();
  });

  it("renders the Scape Journal memory (kind badge, position, text)", () => {
    render(<ScapeOperatorSurface appName={SCAPE_APP_NAME} />);
    const section = document.querySelector(
      '[data-section="Scape Journal"]',
    ) as HTMLElement;
    const scoped = within(section);
    // kind badge.
    expect(scoped.getByText("goal")).toBeTruthy();
    // memory position formatPosition.
    expect(scoped.getByText("3225, 3265")).toBeTruthy();
    // memory text.
    expect(scoped.getByText(/beginning attack training/)).toBeTruthy();
  });

  it("renders the Nearby section with distance-formatted NPCs/players/items/inventory", () => {
    render(<ScapeOperatorSurface appName={SCAPE_APP_NAME} />);
    // NPCs nearest-first: "Cow (1 tile) · Goblin (2 tiles)".
    expect(cardValue("NPCs")).toBe("Cow (1 tile) · Goblin (2 tiles)");
    expect(cardSubtitle("NPCs")).toBe("2 visible");
    // Players: Zezima 5 tiles.
    expect(cardValue("Players")).toBe("Zezima (5 tiles)");
    // Ground Items: Bones (count 1 -> no xN).
    expect(cardValue("Ground Items")).toBe("Bones");
    expect(cardSubtitle("Ground Items")).toBe("1 drops");
    // Inventory: "Shrimps x3 · Bronze dagger" (count 1 omits xN).
    expect(cardValue("Inventory")).toBe("Shrimps x3 · Bronze dagger");
    expect(cardSubtitle("Inventory")).toBe("2 slots");
  });

  it("renders Skills badges (name + level) and Recent Actions when present", async () => {
    // Build a session whose service emits an event-log entry so Recent Actions
    // renders, via the producer (pushEventLog -> activity).
    const withActivity = await buildRealScapeSession({
      status: "connected",
      eventLog: [
        {
          stepNumber: 5,
          action: "walk_to",
          message: "Walking to the cow field.",
          success: true,
        },
        {
          stepNumber: 6,
          action: "attack",
          message: "Could not reach target.",
          success: false,
        },
      ],
    });
    appState.appRuns = [makeScapeRun(withActivity)];

    render(<ScapeOperatorSurface appName={SCAPE_APP_NAME} />);

    const skills = document.querySelector(
      '[data-section="Skills"]',
    ) as HTMLElement;
    const skillScoped = within(skills);
    // Producer priority-sorts Hitpoints first; badge text "Name Level".
    expect(skillScoped.getByText("Hitpoints 10")).toBeTruthy();
    expect(skillScoped.getByText("Attack 4")).toBeTruthy();

    const actions = document.querySelector(
      '[data-section="Recent Actions"]',
    ) as HTMLElement;
    const actionScoped = within(actions);
    // Newest-first: attack (failed -> warn) then walk_to.
    expect(actionScoped.getByText("attack")).toBeTruthy();
    expect(actionScoped.getByText("Could not reach target.")).toBeTruthy();
    expect(actionScoped.getByText("walk_to")).toBeTruthy();
  });
});

describe("ScapeOperatorSurface — CONTROLS (pause/resume)", () => {
  it("Pause enabled + Resume disabled when running; clicking Pause calls controlAppRun(runId,'pause')", async () => {
    controlAppRun.mockResolvedValue({ success: true, message: "paused." });
    appState.appRuns = [makeScapeRun(liveSession)];

    render(<ScapeOperatorSurface appName={SCAPE_APP_NAME} />);
    const controls = document.querySelector(
      '[data-section="Controls"]',
    ) as HTMLElement;
    const pauseBtn = within(controls).getByText("Pause") as HTMLButtonElement;
    const resumeBtn = within(controls).getByText("Resume") as HTMLButtonElement;

    expect(pauseBtn.disabled).toBe(false);
    expect(resumeBtn.disabled).toBe(true);
    // aria-current toggles to Resume when running.
    expect(resumeBtn.getAttribute("aria-current")).toBe("true");
    expect(pauseBtn.getAttribute("aria-current")).toBeNull();
    // Status word.
    expect(within(controls).getByText("Running")).toBeTruthy();

    fireEvent.click(pauseBtn);
    await waitFor(() =>
      expect(controlAppRun).toHaveBeenCalledWith("scape-run", "pause"),
    );
    // statusMessage echoes the resolved response message.
    await waitFor(() => expect(screen.getByText("paused.")).toBeTruthy());
  });

  it("flips Pause/Resume disabled-state + aria-current + hero CTA label when paused; hero CTA resumes", async () => {
    controlAppRun.mockResolvedValue({ success: true, message: "resumed." });
    appState.appRuns = [makeScapeRun(pausedSession, { status: "paused" })];

    render(<ScapeOperatorSurface appName={SCAPE_APP_NAME} />);
    const controls = document.querySelector(
      '[data-section="Controls"]',
    ) as HTMLElement;
    const pauseBtn = within(controls).getByText("Pause") as HTMLButtonElement;
    const resumeBtn = within(controls).getByText("Resume") as HTMLButtonElement;

    expect(pauseBtn.disabled).toBe(true);
    expect(resumeBtn.disabled).toBe(false);
    expect(pauseBtn.getAttribute("aria-current")).toBe("true");
    expect(within(controls).getByText("Paused")).toBeTruthy();
    // "paused" badge appears in the header.
    expect(screen.getAllByText("paused").length).toBeGreaterThan(0);
    // Hero CTA label flips to "Resume" when paused.
    const heroResume = screen.getByText("Resume", {
      selector: "button:not([data-section] *)",
    });
    expect(heroResume).toBeTruthy();

    // Clicking the section Resume button resumes.
    fireEvent.click(resumeBtn);
    await waitFor(() =>
      expect(controlAppRun).toHaveBeenCalledWith("scape-run", "resume"),
    );
    await waitFor(() => expect(screen.getByText("resumed.")).toBeTruthy());
  });
});

describe("ScapeOperatorSurface — STEERING + variant/focus branching", () => {
  it("clicking a suggested prompt sends it and echoes the status message", async () => {
    sendAppRunMessage.mockResolvedValue({
      success: true,
      message: "Operator directive accepted.",
    });
    appState.appRuns = [makeScapeRun(liveSession)];

    render(<ScapeOperatorSurface appName={SCAPE_APP_NAME} />);
    const steering = document.querySelector(
      '[data-section="Steering"]',
    ) as HTMLElement;
    // Producer seeds 3 prompts; the surface slices to 2.
    const promptButtons = within(steering).getAllByRole("button");
    expect(promptButtons.length).toBe(2);
    const firstPrompt = promptButtons[0].textContent ?? "";
    expect(firstPrompt).toContain("Walk to the Lumbridge cows");

    fireEvent.click(promptButtons[0]);
    await waitFor(() =>
      expect(sendAppRunMessage).toHaveBeenCalledWith("scape-run", firstPrompt),
    );
    await waitFor(() =>
      expect(
        within(steering).getByText("Operator directive accepted."),
      ).toBeTruthy(),
    );
  });

  it("does not send when the run has no runId (command bridge pending)", async () => {
    appState.appRuns = [makeScapeRun(liveSession, { runId: null })];
    render(<ScapeOperatorSurface appName={SCAPE_APP_NAME} />);
    const steering = document.querySelector(
      '[data-section="Steering"]',
    ) as HTMLElement;
    const promptButtons = within(steering).getAllByRole("button");
    fireEvent.click(promptButtons[0]);
    await waitFor(() =>
      expect(
        within(steering).getByText("Waiting for the 'scape command bridge."),
      ).toBeTruthy(),
    );
    expect(sendAppRunMessage).not.toHaveBeenCalled();
  });

  it("variant='live' / 'running' set the surface test id + hero title", () => {
    appState.appRuns = [makeScapeRun(liveSession)];
    const { rerender } = render(
      <ScapeOperatorSurface appName={SCAPE_APP_NAME} variant="live" />,
    );
    expect(screen.getByTestId("scape-live-operator-surface")).toBeTruthy();
    expect(screen.getByText("'scape Live Dashboard")).toBeTruthy();

    rerender(
      <ScapeOperatorSurface appName={SCAPE_APP_NAME} variant="running" />,
    );
    expect(screen.getByTestId("scape-running-operator-surface")).toBeTruthy();
    expect(screen.getByText("'scape Run Surface")).toBeTruthy();
  });

  it("focus='chat' shows Steering but hides dashboard sections", () => {
    appState.appRuns = [makeScapeRun(liveSession)];
    render(<ScapeOperatorSurface appName={SCAPE_APP_NAME} focus="chat" />);
    expect(document.querySelector('[data-section="Steering"]')).toBeTruthy();
    // Dashboard-only sections are gone.
    expect(document.querySelector('[data-section="Agent"]')).toBeNull();
    expect(document.querySelector('[data-section="Nearby"]')).toBeNull();
    expect(document.querySelector('[data-section="Controls"]')).toBeNull();
  });

  it("focus='dashboard' shows dashboard sections but hides Steering", () => {
    appState.appRuns = [makeScapeRun(liveSession)];
    render(<ScapeOperatorSurface appName={SCAPE_APP_NAME} focus="dashboard" />);
    expect(document.querySelector('[data-section="Agent"]')).toBeTruthy();
    expect(document.querySelector('[data-section="Nearby"]')).toBeTruthy();
    expect(document.querySelector('[data-section="Steering"]')).toBeNull();
  });
});
