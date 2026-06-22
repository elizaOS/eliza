// @vitest-environment jsdom

// Drives the unified ClawvilleView (the single GUI/XR data wrapper) through the
// rendered DOM: the same component the bundle exports for both the "gui" and
// "xr" modalities. Asserts the quick-action commands, suggested prompts, the
// free-text composer (Field + send), the optimistic local events, the persisted-
// session clear, and the error path all reach the app-run client with the exact
// trimmed arguments — functional parity with the GUI operator surface and the
// retired TUI view-bundle export.

import type { AppRunSummary } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLAWVILLE_APP_NAME,
  makeClawvilleRun,
  makeClawvilleSession,
} from "../ui/test-support.ts";

const sendAppRunMessage = vi.hoisted(() => vi.fn());
const setState = vi.hoisted(() => vi.fn());
const appState = vi.hoisted(() => ({
  appRuns: [] as AppRunSummary[],
  setState,
  setActionNotice: vi.fn(),
}));

vi.mock("@elizaos/ui", () => ({
  client: { sendAppRunMessage },
  useApp: () => appState,
  useAppSelector: <T,>(selector: (s: typeof appState) => T): T =>
    selector(appState),
}));

const { render, screen, fireEvent, waitFor, cleanup } = await import(
  "@testing-library/react"
);
const { ClawvilleView } = await import("./ClawvilleView.tsx");

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

describe("ClawvilleView — unified GUI/XR operator surface", () => {
  it("renders the idle panel with the primary commands when no run exists", () => {
    render(<ClawvilleView />);
    expect(screen.getByText("starting")).toBeTruthy();
    expect(screen.getByText("commands locked")).toBeTruthy();
    expect(screen.getByText("Visit nearest")).toBeTruthy();
    expect(screen.getByText("Ask NPC")).toBeTruthy();
    // No run → composer is disabled, send button cannot fire.
    expect(button("send-command").disabled).toBe(true);
  });

  it("renders populated telemetry: location, learned count, run id", () => {
    appState.appRuns = [makeClawvilleRun()];
    render(<ClawvilleView />);
    expect(screen.getByText("live")).toBeTruthy();
    expect(screen.getByText("commands ready")).toBeTruthy();
    expect(screen.getByText("Krusty Krab")).toBeTruthy();
    expect(screen.getByText("clawville-run")).toBeTruthy();
  });

  it("surfaces PRIMARY_COMMANDS plus the first two suggested prompts as actions", () => {
    appState.appRuns = [makeClawvilleRun()];
    render(<ClawvilleView />);
    expect(button("command-visit-nearest")).toBeTruthy();
    expect(button("command-ask-npc")).toBeTruthy();
    // First two suggested prompts surface; later ones are sliced off.
    expect(screen.getByText("Move to tool workshop")).toBeTruthy();
    expect(screen.queryByText("Move to skill forge")).toBeNull();
  });

  it("sends a primary command and clears local events on a persisted session", async () => {
    sendAppRunMessage.mockResolvedValue({
      success: true,
      message: "Moving.",
      disposition: "accepted",
      status: 200,
      run: makeClawvilleRun(),
      session: makeClawvilleSession(),
    });
    appState.appRuns = [makeClawvilleRun()];
    render(<ClawvilleView />);

    fireEvent.click(button("command-visit-nearest"));
    await waitFor(() =>
      expect(sendAppRunMessage).toHaveBeenCalledWith(
        "clawville-run",
        "Visit the nearest building",
      ),
    );
    // response.run present → setState("appRuns", ...) persists it.
    await waitFor(() =>
      expect(setState).toHaveBeenCalledWith("appRuns", expect.any(Array)),
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
    appState.appRuns = [makeClawvilleRun()];
    render(<ClawvilleView />);

    fireEvent.click(button("command-ask-npc"));
    await waitFor(() =>
      expect(sendAppRunMessage).toHaveBeenCalledWith(
        "clawville-run",
        "Ask the nearest NPC what to learn next",
      ),
    );
    // Optimistic "You" event appears, then the queued server event.
    await waitFor(() => expect(screen.getByText("You")).toBeTruthy());
    await waitFor(() =>
      expect(screen.getByText("Command queued.")).toBeTruthy(),
    );
    expect(screen.getByText("Queued")).toBeTruthy();
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
    appState.appRuns = [makeClawvilleRun()];
    render(<ClawvilleView />);

    fireEvent.change(input("command-input"), {
      target: { value: "  Move to skill forge  " },
    });
    fireEvent.click(button("send-command"));
    await waitFor(() =>
      expect(sendAppRunMessage).toHaveBeenCalledWith(
        "clawville-run",
        "Move to skill forge",
      ),
    );
  });

  it("drives a suggested-prompt action to send that exact prompt", async () => {
    sendAppRunMessage.mockResolvedValue({
      success: true,
      message: "ok",
      disposition: "accepted",
      status: 200,
      run: null,
      session: null,
    });
    appState.appRuns = [makeClawvilleRun()];
    render(<ClawvilleView />);

    fireEvent.click(button("command-Move to tool workshop"));
    await waitFor(() =>
      expect(sendAppRunMessage).toHaveBeenCalledWith(
        "clawville-run",
        "Move to tool workshop",
      ),
    );
  });

  it("renders an error event when the app-run client rejects", async () => {
    sendAppRunMessage.mockRejectedValue(new Error("backend offline"));
    appState.appRuns = [makeClawvilleRun()];
    render(<ClawvilleView />);

    fireEvent.click(button("command-visit-nearest"));
    await screen.findByText("backend offline");
  });

  it("does not send when commands are unavailable (canSend false)", async () => {
    appState.appRuns = [
      makeClawvilleRun({
        session: makeClawvilleSession({ canSendCommands: false }),
      }),
    ];
    render(<ClawvilleView />);
    // Action buttons are disabled; clicking is a no-op.
    expect(button("command-visit-nearest").disabled).toBe(true);
    fireEvent.click(button("command-visit-nearest"));
    await Promise.resolve();
    expect(sendAppRunMessage).not.toHaveBeenCalled();
  });
});
