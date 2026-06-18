// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFENSE_APP_NAME,
  makeDefenseRun,
  makeDefenseSession,
  makeDefenseTelemetry,
} from "./test-support";

const sendAppRunMessage = vi.hoisted(() => vi.fn());
const setActionNotice = vi.hoisted(() => vi.fn());
const setState = vi.hoisted(() => vi.fn());
const appState = vi.hoisted(() => ({
  appRuns: [] as Array<Record<string, unknown>>,
  setActionNotice,
  setState,
}));

vi.mock("@elizaos/app-core/ui-compat", () => ({
  client: { sendAppRunMessage },
  useApp: () => appState,
}));
vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

const { render, screen, fireEvent, waitFor, cleanup } = await import(
  "@testing-library/react"
);
const { DefenseAgentsTuiView } = await import("./DefenseAgentsOperatorSurface");

function readViewState(): Record<string, unknown> {
  const el = document.querySelector("[data-view-state]");
  return JSON.parse(el?.getAttribute("data-view-state") ?? "{}");
}

beforeEach(() => {
  appState.appRuns = [];
  sendAppRunMessage.mockReset();
  setActionNotice.mockReset();
  setState.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("DefenseAgentsTuiView — view state + panel rows", () => {
  it("renders the idle/empty view state and fallback tactical prompts when no run", () => {
    render(<DefenseAgentsTuiView />);

    expect(readViewState()).toMatchObject({
      viewType: "tui",
      viewId: "defense-of-the-agents",
      appName: DEFENSE_APP_NAME,
      runId: null,
      status: "idle",
      canSend: false,
      heroLane: null,
      autoPlay: false,
      tacticalPromptCount: 0,
      eventCount: 0,
    });
    expect(screen.getByText("run none")).toBeTruthy();
    expect(screen.getByText("commands unavailable")).toBeTruthy();
    expect(screen.getByText("lane unassigned")).toBeTruthy();
    // Empty tacticalPrompts → fallback list.
    expect(screen.getByText("review strategy")).toBeTruthy();
    expect(screen.getByText("move to mid")).toBeTruthy();
    expect(screen.getByText("recall")).toBeTruthy();
  });

  it("renders populated telemetry into the view state, meta line, and panel rows", () => {
    appState.appRuns = [makeDefenseRun()];
    render(<DefenseAgentsTuiView />);

    expect(readViewState()).toMatchObject({
      viewType: "tui",
      viewId: "defense-of-the-agents",
      runId: "defense-run",
      status: "running",
      canSend: true,
      heroLine: "Mage Lv3 mid, 80/100 HP",
      heroLane: "mid",
      autoPlay: true,
      // suggestedPrompts → "Move to top lane", "Recall to base", "Review
      // strategy" pass isRelevantPrompt; only "Auto-play OFF" is excluded.
      tacticalPromptCount: 3,
    });
    // Panel rows.
    expect(screen.getByText("run defense-run")).toBeTruthy();
    expect(screen.getByText("commands available")).toBeTruthy();
    expect(screen.getByText("lane mid")).toBeTruthy();
    // meta line: "running | Mage Lv3 mid, 80/100 HP | autoplay on".
    expect(
      screen.getByText(/running \| Mage Lv3 mid, 80\/100 HP \| autoplay\s+on/),
    ).toBeTruthy();
  });
});

describe("DefenseAgentsTuiView — interactions", () => {
  it("sends a typed command on Enter, clears the draft, and posts a success notice", async () => {
    sendAppRunMessage.mockResolvedValue({
      success: true,
      message: "Deployment received.",
      run: makeDefenseRun(),
    });
    appState.appRuns = [makeDefenseRun()];
    render(<DefenseAgentsTuiView />);

    const input = screen.getByLabelText("Defense command") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Move to top lane" } });
    expect(input.value).toBe("Move to top lane");
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(sendAppRunMessage).toHaveBeenCalledWith(
        "defense-run",
        "Move to top lane",
      ),
    );
    await waitFor(() =>
      expect(setActionNotice).toHaveBeenCalledWith(
        "Deployment received.",
        "success",
        2600,
      ),
    );
    // response.run present → persisted via setState.
    expect(setState).toHaveBeenCalledWith("appRuns", expect.any(Array));
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("sends via the send-command button and trims the draft", async () => {
    sendAppRunMessage.mockResolvedValue({
      success: true,
      message: "ok",
      run: null,
    });
    appState.appRuns = [makeDefenseRun()];
    render(<DefenseAgentsTuiView />);

    const input = screen.getByLabelText("Defense command") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  recall  " } });
    fireEvent.click(screen.getByText("send command"));

    await waitFor(() =>
      expect(sendAppRunMessage).toHaveBeenCalledWith("defense-run", "recall"),
    );
  });

  it("drives a tactical-prompt button to send that exact prompt", async () => {
    sendAppRunMessage.mockResolvedValue({
      success: true,
      message: "ok",
      run: null,
    });
    appState.appRuns = [makeDefenseRun()];
    render(<DefenseAgentsTuiView />);

    fireEvent.click(screen.getByText("Move to top lane"));
    await waitFor(() =>
      expect(sendAppRunMessage).toHaveBeenCalledWith(
        "defense-run",
        "Move to top lane",
      ),
    );
  });

  it("posts an error notice when the send fails and does not crash", async () => {
    sendAppRunMessage.mockRejectedValue(new Error("backend offline"));
    appState.appRuns = [makeDefenseRun()];
    render(<DefenseAgentsTuiView />);

    const input = screen.getByLabelText("Defense command") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "recall" } });
    fireEvent.click(screen.getByText("send command"));

    await waitFor(() =>
      expect(setActionNotice).toHaveBeenCalledWith(
        "backend offline",
        "error",
        3200,
      ),
    );
  });

  it("disables the send + tactical-prompt buttons when commands are unavailable", () => {
    appState.appRuns = [
      makeDefenseRun({
        session: makeDefenseSession({
          canSendCommands: false,
          telemetry: makeDefenseTelemetry({ autoPlay: false }),
        }),
      }),
    ];
    render(<DefenseAgentsTuiView />);

    // Send button disabled: !canSend (also empty draft).
    const sendButton = screen.getByText("send command") as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);
    // Tactical-prompt buttons disabled too (!canSend || sending).
    const tactical = screen.getByText("Move to top lane") as HTMLButtonElement;
    expect(tactical.disabled).toBe(true);
    fireEvent.click(tactical);
    expect(sendAppRunMessage).not.toHaveBeenCalled();
  });

  it("never sends when there is no run (sendDraft runId guard)", async () => {
    render(<DefenseAgentsTuiView />);
    const input = screen.getByLabelText("Defense command") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "recall" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // No run → sendDraft early-returns on the runId guard.
    await Promise.resolve();
    expect(sendAppRunMessage).not.toHaveBeenCalled();
  });
});
