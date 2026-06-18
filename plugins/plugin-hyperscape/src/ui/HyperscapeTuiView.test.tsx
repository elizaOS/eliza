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
const setActionNotice = vi.hoisted(() => vi.fn());
const appState = vi.hoisted(() => ({
  appRuns: [] as Array<Record<string, unknown>>,
  setActionNotice,
  setState: vi.fn(),
}));

function latestRunForApp(
  appName: string,
  appRuns: Array<Record<string, unknown>>,
) {
  const matchingRuns = appRuns.filter((run) => run.appName === appName);
  return { run: matchingRuns[0] ?? null, matchingRuns };
}

vi.mock("@elizaos/app-core/ui-compat", () => ({
  client: { sendAppRunMessage, controlAppRun },
  useApp: () => appState,
  selectLatestRunForApp: latestRunForApp,
  // The TUI view path does not render the surface helpers, but they are imported
  // at module scope, so they must exist on the mock.
  SurfaceBadge: ({ children }: { children?: ReactTypes.ReactNode }) => children,
  SurfaceCard: ({ children }: { children?: ReactTypes.ReactNode }) => children,
  SurfaceSection: ({ children }: { children?: ReactTypes.ReactNode }) =>
    children,
  formatDetailTimestamp: (value: unknown) => String(value ?? ""),
  toneForHealthState: () => "neutral",
  toneForStatusText: () => "neutral",
  toneForViewerAttachment: () => "neutral",
}));

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
const { HyperscapeTuiView } = await import("./HyperscapeOperatorSurface");

function readViewState(): Record<string, unknown> {
  const el = document.querySelector("[data-view-state]");
  return JSON.parse(el?.getAttribute("data-view-state") ?? "{}");
}

beforeEach(() => {
  appState.appRuns = [];
  sendAppRunMessage.mockReset();
  controlAppRun.mockReset();
  setActionNotice.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("HyperscapeTuiView", () => {
  it("renders the idle/empty view state and fallback prompts when there is no run", () => {
    render(<HyperscapeTuiView />);

    expect(readViewState()).toMatchObject({
      viewType: "tui",
      viewId: "hyperscape",
      appName: HYPERSCAPE_APP_NAME,
      runId: null,
      status: "idle",
      canSend: false,
      sessionId: null,
      followEntity: null,
      activeRunCount: 0,
      recentActivityCount: 0,
      suggestedPromptCount: 0,
    });
    expect(screen.getByText("run none")).toBeTruthy();
    expect(screen.getByText("session none")).toBeTruthy();
    expect(screen.getByText("commands unavailable")).toBeTruthy();
    // Fallback prompts when session has none.
    expect(screen.getByText("look around")).toBeTruthy();
    expect(screen.getByText("follow target")).toBeTruthy();
    // Meta line reads idle | viewer pending | unknown.
    expect(screen.getByText("idle | viewer pending | unknown")).toBeTruthy();
  });

  it("renders the populated view-state, panel lines, and meta line", () => {
    appState.appRuns = [makeHyperscapeRun()];
    render(<HyperscapeTuiView />);

    expect(readViewState()).toMatchObject({
      viewType: "tui",
      viewId: "hyperscape",
      runId: "hyper-run",
      status: "running",
      health: "healthy",
      viewerAttachment: "attached",
      activeRunCount: 1,
      sessionId: "hyper-agent-1",
      canSend: true,
      followEntity: "milady-character",
      characterId: "milady-character",
      suggestedPromptCount: 3,
    });
    expect(screen.getByText("run hyper-run")).toBeTruthy();
    expect(screen.getByText("session hyper-agent-1")).toBeTruthy();
    expect(screen.getByText("follow milady-character")).toBeTruthy();
    expect(screen.getByText("commands available")).toBeTruthy();
    // meta line: "running | attached | healthy".
    expect(screen.getByText("running | attached | healthy")).toBeTruthy();
  });

  it("sends a typed command on Enter, clears the draft, and posts a success notice", async () => {
    sendAppRunMessage.mockResolvedValue({ success: true, message: "Sent." });
    appState.appRuns = [makeHyperscapeRun()];
    render(<HyperscapeTuiView />);

    const input = screen.getByLabelText(
      "Hyperscape command",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "explore north" } });
    expect(input.value).toBe("explore north");
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(sendAppRunMessage).toHaveBeenCalledWith(
        "hyper-run",
        "explore north",
      ),
    );
    await waitFor(() =>
      expect(setActionNotice).toHaveBeenCalledWith("Sent.", "success", 2600),
    );
    await waitFor(() => expect(input.value).toBe(""));
  });

  it("sends via the send-command button and trims the draft", async () => {
    sendAppRunMessage.mockResolvedValue({ success: true, message: "ok" });
    appState.appRuns = [makeHyperscapeRun()];
    render(<HyperscapeTuiView />);

    const input = screen.getByLabelText(
      "Hyperscape command",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "  greet merchant  " } });
    fireEvent.click(screen.getByText("send command"));

    await waitFor(() =>
      expect(sendAppRunMessage).toHaveBeenCalledWith(
        "hyper-run",
        "greet merchant",
      ),
    );
  });

  it("drives a suggested-prompt button to send that exact prompt", async () => {
    sendAppRunMessage.mockResolvedValue({ success: true, message: "ok" });
    appState.appRuns = [makeHyperscapeRun()];
    render(<HyperscapeTuiView />);

    fireEvent.click(screen.getByText("follow the merchant"));
    await waitFor(() =>
      expect(sendAppRunMessage).toHaveBeenCalledWith(
        "hyper-run",
        "follow the merchant",
      ),
    );
  });

  it("posts an error notice when the send throws (does not crash)", async () => {
    sendAppRunMessage.mockRejectedValue(new Error("backend offline"));
    appState.appRuns = [makeHyperscapeRun()];
    render(<HyperscapeTuiView />);

    const input = screen.getByLabelText(
      "Hyperscape command",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "look around" } });
    fireEvent.click(screen.getByText("send command"));

    await waitFor(() =>
      expect(setActionNotice).toHaveBeenCalledWith(
        "backend offline",
        "error",
        3200,
      ),
    );
  });

  it("does not send when there is no run id (sendDraft early-returns)", async () => {
    render(<HyperscapeTuiView />);
    const input = screen.getByLabelText(
      "Hyperscape command",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "look around" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await Promise.resolve();
    expect(sendAppRunMessage).not.toHaveBeenCalled();
  });

  it("disables the suggested-prompt + send buttons when commands are unavailable", () => {
    appState.appRuns = [
      makeHyperscapeRun({
        session: makeHyperscapeSession({ canSendCommands: false }),
      }),
    ];
    render(<HyperscapeTuiView />);

    expect(readViewState()).toMatchObject({ canSend: false });
    // suggested-prompt buttons are disabled when !canSend.
    const prompt = screen.getByText("look around") as HTMLButtonElement;
    expect(prompt.disabled).toBe(true);
    // The send-command button is disabled (canSend false + empty draft).
    const send = screen.getByText("send command") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
  });
});
