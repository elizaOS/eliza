// @vitest-environment jsdom

// Drives the unified DefenseAgentsView (the single GUI/XR data wrapper) through
// the rendered DOM: the same component the bundle exports for both the "gui" and
// "xr" modalities. Asserts the lane/recall/autoplay commands, the suggested
// prompts, the free-text composer (Field + send), the optimistic local events,
// the persisted-session clear, and the error path all reach the app-run client
// with the exact command strings the legacy operator surface sent — functional
// parity with the GUI operator surface and the retired TUI view-bundle export.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  makeDefenseRun,
  makeDefenseSession,
  makeDefenseTelemetry,
} from "../ui/test-support.ts";

const sendAppRunMessage = vi.hoisted(() => vi.fn());
const setState = vi.hoisted(() => vi.fn());
const appState = vi.hoisted(() => ({
  appRuns: [] as Array<Record<string, unknown>>,
  setState,
  setActionNotice: vi.fn(),
}));

vi.mock("@elizaos/app-core/ui-compat", () => ({
  client: { sendAppRunMessage },
  useApp: () => appState,
  useAppSelectorShallow: <T,>(selector: (s: typeof appState) => T): T =>
    selector(appState),
}));

const { render, screen, fireEvent, waitFor, cleanup } = await import(
  "@testing-library/react"
);
const { DefenseAgentsView } = await import("./DefenseAgentsView.tsx");

function button(agentId: string): HTMLButtonElement {
  const el = document.querySelector(`[data-agent-id="${agentId}"]`);
  if (!el) throw new Error(`no element with data-agent-id="${agentId}"`);
  return el as HTMLButtonElement;
}

function input(agentId: string): HTMLInputElement {
  const el = document.querySelector(`[data-agent-id="${agentId}"]`);
  if (!el) throw new Error(`no element with data-agent-id="${agentId}"`);
  return el as HTMLInputElement;
}

beforeEach(() => {
  appState.appRuns = [];
  sendAppRunMessage.mockReset();
  setState.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("DefenseAgentsView — unified GUI/XR operator surface", () => {
  it("renders the idle panel with command buttons disabled when no run exists", () => {
    render(<DefenseAgentsView />);
    expect(screen.getByText("idle")).toBeTruthy();
    expect(screen.getByText("relay syncing")).toBeTruthy();
    expect(screen.getByText("no live match")).toBeTruthy();
    // No run → command buttons + composer are disabled.
    expect(button("command-recall").disabled).toBe(true);
    expect(button("command-lane-mid").disabled).toBe(true);
    expect(button("send-command").disabled).toBe(true);
  });

  it("renders populated telemetry: hero line, lane, run id, relay ready", () => {
    appState.appRuns = [makeDefenseRun()];
    render(<DefenseAgentsView />);
    expect(screen.getByText("live")).toBeTruthy();
    expect(screen.getByText("relay ready")).toBeTruthy();
    expect(screen.getByText("Mage Lv3 mid, 80/100 HP")).toBeTruthy();
    expect(screen.getByText("run defense-run")).toBeTruthy();
  });

  it("sends 'Recall to base' when the recall command is pressed", async () => {
    sendAppRunMessage.mockResolvedValue({
      success: true,
      message: "Recalling.",
      disposition: "accepted",
      status: 200,
      run: makeDefenseRun(),
      session: makeDefenseSession(),
    });
    appState.appRuns = [makeDefenseRun()];
    render(<DefenseAgentsView />);

    fireEvent.click(button("command-recall"));
    await waitFor(() =>
      expect(sendAppRunMessage).toHaveBeenCalledWith(
        "defense-run",
        "Recall to base",
      ),
    );
    // response.run present → setState("appRuns", ...) persists it.
    await waitFor(() =>
      expect(setState).toHaveBeenCalledWith("appRuns", expect.any(Array)),
    );
  });

  it("sends 'Move to <lane> lane' when a lane command is pressed", async () => {
    sendAppRunMessage.mockResolvedValue({
      success: true,
      message: "Moving.",
      disposition: "accepted",
      status: 200,
      run: null,
      session: null,
    });
    appState.appRuns = [makeDefenseRun()];
    render(<DefenseAgentsView />);

    fireEvent.click(button("command-lane-top"));
    await waitFor(() =>
      expect(sendAppRunMessage).toHaveBeenCalledWith(
        "defense-run",
        "Move to top lane",
      ),
    );
  });

  it("toggles autoplay: sends OFF when autoplay is on", async () => {
    sendAppRunMessage.mockResolvedValue({
      success: true,
      message: "ok",
      disposition: "accepted",
      status: 200,
      run: null,
      session: null,
    });
    appState.appRuns = [makeDefenseRun()];
    render(<DefenseAgentsView />);

    // makeDefenseTelemetry has autoPlay: true → toggle sends OFF.
    fireEvent.click(button("command-autoplay"));
    await waitFor(() =>
      expect(sendAppRunMessage).toHaveBeenCalledWith(
        "defense-run",
        "Auto-play OFF",
      ),
    );
  });

  it("maps a queued disposition to an optimistic local event when no session persists", async () => {
    sendAppRunMessage.mockResolvedValue({
      success: true,
      message: "Command queued.",
      disposition: "queued",
      status: 202,
      run: null,
      session: null,
    });
    appState.appRuns = [makeDefenseRun()];
    render(<DefenseAgentsView />);

    fireEvent.click(button("command-recall"));
    await waitFor(() => expect(screen.getByText("You")).toBeTruthy());
    await waitFor(() =>
      expect(screen.getByText("Command queued.")).toBeTruthy(),
    );
  });

  it("sends the trimmed free-text draft via the composer + send button", async () => {
    sendAppRunMessage.mockResolvedValue({
      success: true,
      message: "ok",
      disposition: "accepted",
      status: 200,
      run: null,
      session: null,
    });
    appState.appRuns = [makeDefenseRun()];
    render(<DefenseAgentsView />);

    fireEvent.change(input("command-input"), {
      target: { value: "  Reinforce mid  " },
    });
    fireEvent.click(button("send-command"));
    await waitFor(() =>
      expect(sendAppRunMessage).toHaveBeenCalledWith(
        "defense-run",
        "Reinforce mid",
      ),
    );
  });

  it("drives a suggested-prompt button to send that exact prompt", async () => {
    sendAppRunMessage.mockResolvedValue({
      success: true,
      message: "ok",
      disposition: "accepted",
      status: 200,
      run: null,
      session: null,
    });
    appState.appRuns = [makeDefenseRun()];
    render(<DefenseAgentsView />);

    // "Move to top lane" passes isRelevantPrompt and surfaces as a prompt button.
    fireEvent.click(button("prompt-Move to top lane"));
    await waitFor(() =>
      expect(sendAppRunMessage).toHaveBeenCalledWith(
        "defense-run",
        "Move to top lane",
      ),
    );
  });

  it("renders an error event when the app-run client rejects", async () => {
    sendAppRunMessage.mockRejectedValue(new Error("backend offline"));
    appState.appRuns = [makeDefenseRun()];
    render(<DefenseAgentsView />);

    fireEvent.click(button("command-recall"));
    await screen.findByText("backend offline");
  });

  it("does not send when commands are unavailable (canSend false)", async () => {
    appState.appRuns = [
      makeDefenseRun({
        session: makeDefenseSession({
          canSendCommands: false,
          telemetry: makeDefenseTelemetry({ autoPlay: false }),
        }),
      }),
    ];
    render(<DefenseAgentsView />);
    // Command buttons are disabled; clicking is a no-op.
    expect(button("command-recall").disabled).toBe(true);
    fireEvent.click(button("command-recall"));
    await Promise.resolve();
    expect(sendAppRunMessage).not.toHaveBeenCalled();
  });
});
