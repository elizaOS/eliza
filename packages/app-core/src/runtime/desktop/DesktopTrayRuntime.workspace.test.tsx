/**
 * Behavioral coverage for the tray "Open Desktop Workspace" route and the tray
 * error-visibility boundary in DesktopTrayRuntime. Renders the real headless
 * component in jsdom and drives the real TRAY_ACTION_EVENT listener; only the
 * cross-package @elizaos/ui bridge/store boundaries are substituted, so the
 * component's own routing and failure translation are exercised for real.
 */
// @vitest-environment jsdom

import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { bridge, store } = vi.hoisted(() => ({
  bridge: {
    openDesktopWorkspaceWindow: vi.fn(async () => {}),
    openDesktopSettingsWindow: vi.fn(async () => {}),
    invokeDesktopBridgeRequest: vi.fn(async () => undefined),
    openDesktopAppWindow: vi.fn(async () => ({ id: "app_view" })),
  },
  store: {
    agentStatus: { state: "stopped" },
    handleRestart: vi.fn(async () => {}),
    handleReset: vi.fn(async () => {}),
    handleResetAppliedFromMain: vi.fn(),
    handleStart: vi.fn(async () => {}),
    handleStop: vi.fn(async () => {}),
    setActionNotice: vi.fn(),
    setTab: vi.fn(),
    switchShellView: vi.fn(),
    t: (_key: string, vars?: { defaultValue?: string }) =>
      vars?.defaultValue ?? "",
  },
}));

vi.mock("@elizaos/ui/bridge/electrobun-rpc", () => ({
  getElectrobunRendererRpc: () => ({ request: {} }),
  invokeDesktopBridgeRequest: bridge.invokeDesktopBridgeRequest,
  openDesktopAppWindow: bridge.openDesktopAppWindow,
  subscribeDesktopBridgeEvent: () => () => {},
}));

vi.mock("@elizaos/ui/bridge/electrobun-runtime", () => ({
  isElectrobunRuntime: () => true,
}));

vi.mock("@elizaos/ui/utils/desktop-workspace", () => ({
  openDesktopWorkspaceWindow: bridge.openDesktopWorkspaceWindow,
  openDesktopSettingsWindow: bridge.openDesktopSettingsWindow,
}));

vi.mock("@elizaos/ui/state/useApp", () => ({ useApp: () => store }));

import { TRAY_ACTION_EVENT } from "@elizaos/ui/events";
import { TOAST_TTL_MS } from "@elizaos/ui/state/action-notice";
import { DesktopTrayRuntime } from "./DesktopTrayRuntime";

function clickTray(itemId: string): void {
  document.dispatchEvent(
    new CustomEvent(TRAY_ACTION_EVENT, { detail: { itemId } }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  bridge.openDesktopWorkspaceWindow.mockResolvedValue(undefined);
});

afterEach(() => {
  cleanup();
});

describe("DesktopTrayRuntime — Desktop Workspace launch", () => {
  it("routes the tray item to the managed workspace shell, not the settings window", async () => {
    render(<DesktopTrayRuntime />);

    clickTray("tray-open-desktop-workspace");

    await waitFor(() => {
      expect(bridge.openDesktopWorkspaceWindow).toHaveBeenCalledOnce();
    });
    expect(bridge.openDesktopSettingsWindow).not.toHaveBeenCalled();
    expect(store.setActionNotice).not.toHaveBeenCalled();
  });

  it("shows a distinct error notice when the workspace launch rejects", async () => {
    bridge.openDesktopWorkspaceWindow.mockRejectedValueOnce(
      new Error("Desktop workspace bridge returned no managed window"),
    );
    render(<DesktopTrayRuntime />);

    clickTray("tray-open-desktop-workspace");

    await waitFor(() => {
      expect(store.setActionNotice).toHaveBeenCalledWith(
        "Unable to complete the desktop action. Please retry.",
        "error",
        TOAST_TTL_MS.notificationInterruptive,
      );
    });
  });

  it("shows the same error notice when any other tray RPC rejects", async () => {
    bridge.invokeDesktopBridgeRequest.mockRejectedValueOnce(
      new Error("bridge detached"),
    );
    render(<DesktopTrayRuntime />);

    clickTray("tray-hide-window");

    await waitFor(() => {
      expect(store.setActionNotice).toHaveBeenCalledWith(
        expect.any(String),
        "error",
        TOAST_TTL_MS.notificationInterruptive,
      );
    });
  });

  it("raises no notice for a successful tray dispatch", async () => {
    render(<DesktopTrayRuntime />);

    clickTray("tray-hide-window");

    await waitFor(() => {
      expect(bridge.invokeDesktopBridgeRequest).toHaveBeenCalled();
    });
    await Promise.resolve();
    expect(store.setActionNotice).not.toHaveBeenCalled();
  });
});
