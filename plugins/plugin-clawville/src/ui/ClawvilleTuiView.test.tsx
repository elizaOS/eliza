// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CLAWVILLE_APP_NAME, makeClawvilleRun } from "./test-support";

const sendAppRunMessage = vi.hoisted(() => vi.fn());
const setActionNotice = vi.hoisted(() => vi.fn());
const setState = vi.hoisted(() => vi.fn());
const appState = vi.hoisted(() => ({
  appRuns: [] as Array<Record<string, unknown>>,
  setActionNotice,
  setState,
}));

vi.mock("@elizaos/ui", () => ({
  client: { sendAppRunMessage },
  useApp: () => appState,
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

const { render, screen, fireEvent, waitFor, cleanup } = await import(
  "@testing-library/react"
);
const { ClawvilleTuiView } = await import("./ClawvilleOperatorSurface");

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

describe("ClawvilleTuiView", () => {
  it("renders the idle/empty view state when there is no run", () => {
    render(<ClawvilleTuiView />);

    expect(readViewState()).toMatchObject({
      viewType: "tui",
      viewId: "clawville",
      appName: CLAWVILLE_APP_NAME,
      runId: null,
      status: "idle",
      canSend: false,
      nearestBuilding: "unknown",
      knowledgeCount: null,
      eventCount: 0,
    });
    // With no run the panel falls back to the PRIMARY_COMMANDS as prompts.
    expect(screen.getByText("run none")).toBeTruthy();
    expect(screen.getByText("commands unavailable")).toBeTruthy();
    expect(screen.getByText("Visit the nearest building")).toBeTruthy();
  });

  it("renders populated telemetry into the view state and meta line", () => {
    appState.appRuns = [makeClawvilleRun()];
    render(<ClawvilleTuiView />);

    expect(readViewState()).toMatchObject({
      viewType: "tui",
      viewId: "clawville",
      runId: "clawville-run",
      status: "running",
      canSend: true,
      nearestBuilding: "Krusty Krab",
      knowledgeCount: 2,
      suggestedPromptCount: 4,
    });
    expect(screen.getByText("run clawville-run")).toBeTruthy();
    expect(screen.getByText("commands available")).toBeTruthy();
    // meta line: "running | near Krusty Krab | 2 learned"
    expect(
      screen.getByText(/running \| near Krusty Krab \| 2 learned/),
    ).toBeTruthy();
  });

  it("sends a typed command on Enter and clears the draft + posts a success notice", async () => {
    sendAppRunMessage.mockResolvedValue({
      success: true,
      message: "Moving.",
      disposition: "accepted",
      status: 200,
      run: makeClawvilleRun(),
    });
    appState.appRuns = [makeClawvilleRun()];
    render(<ClawvilleTuiView />);

    const input = screen.getByLabelText(
      "ClawVille command",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Move to skill forge" } });
    expect(input.value).toBe("Move to skill forge");
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(sendAppRunMessage).toHaveBeenCalledWith(
        "clawville-run",
        "Move to skill forge",
      ),
    );
    await waitFor(() =>
      expect(setActionNotice).toHaveBeenCalledWith("Moving.", "success", 2600),
    );
    // response.run present → persisted via setState.
    expect(setState).toHaveBeenCalledWith("appRuns", expect.any(Array));
    // draft is cleared after a successful send.
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("sends via the send-command button and trims the draft", async () => {
    sendAppRunMessage.mockResolvedValue({
      success: true,
      message: "Message sent.",
      disposition: "accepted",
      status: 200,
      run: null,
    });
    appState.appRuns = [makeClawvilleRun()];
    render(<ClawvilleTuiView />);

    const input = screen.getByLabelText(
      "ClawVille command",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  hello reef  " } });
    fireEvent.click(screen.getByText("send command"));

    await waitFor(() =>
      expect(sendAppRunMessage).toHaveBeenCalledWith(
        "clawville-run",
        "hello reef",
      ),
    );
  });

  it("posts an error notice when the send fails and does not crash", async () => {
    sendAppRunMessage.mockRejectedValue(new Error("backend offline"));
    appState.appRuns = [makeClawvilleRun()];
    render(<ClawvilleTuiView />);

    const input = screen.getByLabelText(
      "ClawVille command",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Visit nearest" } });
    fireEvent.click(screen.getByText("send command"));

    await waitFor(() =>
      expect(setActionNotice).toHaveBeenCalledWith(
        "backend offline",
        "error",
        3200,
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
    });
    appState.appRuns = [makeClawvilleRun()];
    render(<ClawvilleTuiView />);

    fireEvent.click(screen.getByText("Move to tool workshop"));
    await waitFor(() =>
      expect(sendAppRunMessage).toHaveBeenCalledWith(
        "clawville-run",
        "Move to tool workshop",
      ),
    );
  });

  it("does not send when commands are unavailable (no run id / canSend false)", async () => {
    render(<ClawvilleTuiView />);
    const input = screen.getByLabelText(
      "ClawVille command",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Move" } });
    fireEvent.keyDown(input, { key: "Enter" });

    // No run → sendDraft early-returns; client must not be called.
    await Promise.resolve();
    expect(sendAppRunMessage).not.toHaveBeenCalled();
  });
});
