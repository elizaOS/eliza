/**
 * Behavioral coverage for the palette's "Open Desktop Workspace" entry: the
 * real <CommandPalette> is rendered in jsdom and the real option is clicked, so
 * both the managed-shell route and the error-visibility boundary are exercised
 * end to end within the component. Only the desktop bridge, view catalog, and
 * shell store boundaries are substituted.
 */
// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { bridge, state } = vi.hoisted(() => ({
  bridge: {
    openDesktopWorkspaceWindow: vi.fn(async () => {}),
    openDesktopSettingsWindow: vi.fn(async () => {}),
    openDesktopSurfaceWindow: vi.fn(async () => {}),
    requestDesktopBridge: vi.fn(async () => undefined),
  },
  state: {
    commandPaletteOpen: true,
    commandQuery: "Desktop Workspace",
    commandActiveIndex: 0,
    agentStatus: { state: "stopped" },
    handleStart: vi.fn(),
    handleStop: vi.fn(),
    handleRestart: vi.fn(),
    setTab: vi.fn(),
    loadPlugins: vi.fn(),
    loadSkills: vi.fn(),
    loadLogs: vi.fn(),
    loadWorkbench: vi.fn(),
    handleChatClear: vi.fn(),
    activeGameViewerUrl: "",
    setState: vi.fn(),
    setActionNotice: vi.fn(),
    t: (_key: string, vars?: { defaultValue?: string }) =>
      vars?.defaultValue ?? "",
  },
}));

vi.mock("../../bridge", () => ({ isElectrobunRuntime: () => true }));
vi.mock("../../utils", () => bridge);
vi.mock("../../hooks", () => ({ useBugReport: () => ({ open: vi.fn() }) }));
vi.mock("../../hooks/useAvailableViews", () => ({
  useAvailableViews: () => ({ views: [] }),
}));
vi.mock("../../state/useViewKinds", () => ({
  useEnabledViewKinds: () => new Set<string>(),
}));
vi.mock("../../state", () => ({
  useAppSelectorShallow: <T,>(selector: (s: typeof state) => T): T =>
    selector(state),
}));

import { TOAST_TTL_MS } from "../../state/action-notice";
import { CommandPalette } from "./CommandPalette";

async function clickWorkspaceCommand(): Promise<void> {
  render(<CommandPalette />);
  const option = await screen.findByText("Open Desktop Workspace");
  (option.closest("button") ?? option).dispatchEvent(
    new MouseEvent("click", { bubbles: true }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  bridge.openDesktopWorkspaceWindow.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe("<CommandPalette> Desktop Workspace entry", () => {
  it("launches the managed workspace shell instead of the settings window", async () => {
    await clickWorkspaceCommand();

    await waitFor(() => {
      expect(bridge.openDesktopWorkspaceWindow).toHaveBeenCalledOnce();
    });
    expect(bridge.openDesktopSettingsWindow).not.toHaveBeenCalled();
    expect(state.setActionNotice).not.toHaveBeenCalled();
  });

  it("surfaces a distinct error notice when the launch rejects", async () => {
    bridge.openDesktopWorkspaceWindow.mockRejectedValueOnce(
      new Error("Desktop workspace bridge returned no managed window"),
    );

    await clickWorkspaceCommand();

    await waitFor(() => {
      expect(state.setActionNotice).toHaveBeenCalledWith(
        "Unable to open the desktop workspace. Please retry.",
        "error",
        TOAST_TTL_MS.notificationInterruptive,
      );
    });
  });
});
