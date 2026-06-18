// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildRealScapeSession, makeScapeRun } from "./test-support";

const sendAppRunMessage = vi.hoisted(() => vi.fn());
const setActionNotice = vi.hoisted(() => vi.fn());
const setState = vi.hoisted(() => vi.fn());
const appState = vi.hoisted(() => ({
  appRuns: [] as Array<Record<string, unknown>>,
  setActionNotice,
  setState,
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

const uiMock = {
  client: { sendAppRunMessage },
  useApp: () => appState,
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
  selectLatestRunForApp: latestRunForApp,
  // These are imported by ScapeOperatorSurface (same module) but unused by the
  // TUI view; provide harmless stubs so the module evaluates.
  SurfaceBadge: () => null,
  SurfaceCard: () => null,
  SurfaceSection: () => null,
  Button: () => null,
  formatDetailTimestamp: (v: unknown) => String(v),
  toneForHealthState: () => "neutral",
  toneForStatusText: () => "neutral",
  toneForViewerAttachment: () => "neutral",
};

vi.mock("@elizaos/app-core/ui-compat", () => uiMock);
vi.mock("@elizaos/ui", () => uiMock);
vi.mock("@elizaos/ui/agent-surface", () => uiMock);

const { render, screen, fireEvent, waitFor, cleanup } = await import(
  "@testing-library/react"
);
const { ScapeTuiView } = await import("./ScapeOperatorSurface");

function readViewState(): Record<string, unknown> {
  const el = document.querySelector("[data-view-state]");
  return JSON.parse(el?.getAttribute("data-view-state") ?? "{}");
}

let liveSession: Awaited<ReturnType<typeof buildRealScapeSession>>;

beforeEach(async () => {
  appState.appRuns = [];
  sendAppRunMessage.mockReset();
  setActionNotice.mockReset();
  setState.mockReset();
  liveSession = await buildRealScapeSession({ status: "connected" });
});

afterEach(() => {
  cleanup();
});

describe("ScapeTuiView — data-view-state derivation + panel", () => {
  it("renders idle view-state + fallback prompts when there is no run", () => {
    render(<ScapeTuiView />);

    expect(readViewState()).toMatchObject({
      viewType: "tui",
      viewId: "scape",
      appName: "@elizaos/plugin-scape",
      runId: null,
      status: "idle",
      canSend: false,
      paused: false,
      connectionStatus: "idle",
      agent: null,
      activeGoal: null,
      inventoryCount: 0,
      skillCount: 0,
      nearbyNpcCount: 0,
    });
    // Panel fallbacks.
    expect(screen.getByText("run none")).toBeTruthy();
    expect(screen.getByText("agent unknown")).toBeTruthy();
    expect(screen.getByText("commands unavailable")).toBeTruthy();
    // Fallback suggested-prompt list when session.suggestedPrompts is empty.
    expect(screen.getByText("check status")).toBeTruthy();
    expect(screen.getByText("set goal")).toBeTruthy();
    expect(screen.getByText("pause")).toBeTruthy();
  });

  it("derives populated counts + nested blocks from real producer telemetry", () => {
    appState.appRuns = [makeScapeRun(liveSession)];
    render(<ScapeTuiView />);

    expect(readViewState()).toMatchObject({
      viewType: "tui",
      viewId: "scape",
      runId: "scape-run",
      status: "running",
      canSend: true,
      paused: false,
      connectionStatus: "connected",
      agent: {
        name: "LumbridgeRanger",
        combatLevel: 4,
        hp: 8,
        maxHp: 10,
        runEnergy: 91,
        inCombat: false,
        position: { x: 3225, z: 3265 },
      },
      activeGoal: {
        id: "goal-1",
        title: "Train attack on cows",
        status: "active",
        progress: 0.25,
      },
      inventoryCount: 2,
      skillCount: 3,
      memoryCount: 1,
      nearbyNpcCount: 2,
      nearbyPlayerCount: 1,
      nearbyItemCount: 1,
      suggestedPromptCount: 3,
    });

    // Meta + panel text.
    expect(screen.getByText(/running \| connected \| running/)).toBeTruthy();
    expect(screen.getByText("run scape-run")).toBeTruthy();
    expect(screen.getByText("agent LumbridgeRanger")).toBeTruthy();
    expect(screen.getByText("position 3225, 3265")).toBeTruthy();
    expect(screen.getByText("goal Train attack on cows")).toBeTruthy();
    expect(screen.getByText("commands available")).toBeTruthy();
  });

  it("renders the session suggested prompts (real producer seeds 3) as buttons", () => {
    appState.appRuns = [makeScapeRun(liveSession)];
    render(<ScapeTuiView />);
    expect(
      screen.getByText("Walk to the Lumbridge cows and train attack."),
    ).toBeTruthy();
    expect(screen.getByText("Pause and tell me what you see.")).toBeTruthy();
  });
});

describe("ScapeTuiView — interactive controls", () => {
  it("sends a typed command via the send button (trimming) + clears draft + success notice", async () => {
    sendAppRunMessage.mockResolvedValue({ success: true, message: "Queued." });
    appState.appRuns = [makeScapeRun(liveSession)];
    render(<ScapeTuiView />);

    const input = screen.getByLabelText("'scape command") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  walk to the cows  " } });
    expect(input.value).toBe("  walk to the cows  ");

    fireEvent.click(screen.getByText("send command"));
    await waitFor(() =>
      expect(sendAppRunMessage).toHaveBeenCalledWith(
        "scape-run",
        "walk to the cows",
      ),
    );
    await waitFor(() =>
      expect(setActionNotice).toHaveBeenCalledWith("Queued.", "success", 2600),
    );
    // Draft cleared on success.
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("submits the typed command on Enter", async () => {
    sendAppRunMessage.mockResolvedValue({ success: true, message: "ok" });
    appState.appRuns = [makeScapeRun(liveSession)];
    render(<ScapeTuiView />);

    const input = screen.getByLabelText("'scape command") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "attack the cow" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(sendAppRunMessage).toHaveBeenCalledWith(
        "scape-run",
        "attack the cow",
      ),
    );
  });

  it("drives a suggested-prompt button to send that exact prompt", async () => {
    sendAppRunMessage.mockResolvedValue({ success: true, message: "ok" });
    appState.appRuns = [makeScapeRun(liveSession)];
    render(<ScapeTuiView />);

    fireEvent.click(
      screen.getByText("Walk to the Lumbridge cows and train attack."),
    );
    await waitFor(() =>
      expect(sendAppRunMessage).toHaveBeenCalledWith(
        "scape-run",
        "Walk to the Lumbridge cows and train attack.",
      ),
    );
  });

  it("posts an error notice when the send fails (and does not crash)", async () => {
    sendAppRunMessage.mockRejectedValue(new Error("bot-SDK offline"));
    appState.appRuns = [makeScapeRun(liveSession)];
    render(<ScapeTuiView />);

    const input = screen.getByLabelText("'scape command") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "eat shrimps" } });
    fireEvent.click(screen.getByText("send command"));

    await waitFor(() =>
      expect(setActionNotice).toHaveBeenCalledWith(
        "bot-SDK offline",
        "error",
        3200,
      ),
    );
  });

  it("disables the send button when the draft is empty", () => {
    appState.appRuns = [makeScapeRun(liveSession)];
    render(<ScapeTuiView />);
    const sendBtn = screen.getByText("send command") as HTMLButtonElement;
    // Empty draft -> disabled.
    expect(sendBtn.disabled).toBe(true);

    const input = screen.getByLabelText("'scape command") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "go" } });
    expect(sendBtn.disabled).toBe(false);
  });

  it("disables the send + suggested-prompt buttons when canSend is false", async () => {
    // Build a session whose canSendCommands is false by stripping that flag.
    const session = { ...liveSession, canSendCommands: false };
    appState.appRuns = [makeScapeRun(session)];
    render(<ScapeTuiView />);

    expect(readViewState()).toMatchObject({ canSend: false });

    const sendBtn = screen.getByText("send command") as HTMLButtonElement;
    expect(sendBtn.disabled).toBe(true);
    // Suggested-prompt buttons disabled too.
    const prompt = screen.getByText(
      "Walk to the Lumbridge cows and train attack.",
    ) as HTMLButtonElement;
    expect(prompt.disabled).toBe(true);

    // Clicking the disabled buttons does not dispatch (the canSend gate).
    fireEvent.click(sendBtn);
    fireEvent.click(prompt);
    await Promise.resolve();
    expect(sendAppRunMessage).not.toHaveBeenCalled();
  });

  it("does not send when there is no run (no runId)", async () => {
    render(<ScapeTuiView />);
    // Fallback prompts render but canSend is false.
    const prompt = screen.getByText("check status") as HTMLButtonElement;
    expect(prompt.disabled).toBe(true);
    fireEvent.click(prompt);
    await Promise.resolve();
    expect(sendAppRunMessage).not.toHaveBeenCalled();
  });
});
