/**
 * Covers the desktop shortcut recorder at its native registration boundary.
 * A rejected replacement must preserve the saved push-to-talk accelerator.
 */
// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopShortcutsSection } from "./DesktopShortcutsSection";

const bridge = vi.hoisted(() => ({ request: vi.fn() }));
const shortcutStore = vi.hoisted(() => ({
  get: vi.fn(() => "CommandOrControl+Shift+Space"),
  set: vi.fn(),
}));

vi.mock("../../bridge", () => ({
  invokeDesktopBridgeRequest: bridge.request,
}));

vi.mock("../../state/push-to-talk-hotkey", () => ({
  DEFAULT_PUSH_TO_TALK_ACCELERATOR: "CommandOrControl+Shift+Space",
  getPushToTalkAccelerator: shortcutStore.get,
  setPushToTalkAccelerator: shortcutStore.set,
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  shortcutStore.get.mockReturnValue("CommandOrControl+Shift+Space");
});

describe("DesktopShortcutsSection", () => {
  it("persists a shortcut only after native registration succeeds", async () => {
    bridge.request.mockResolvedValueOnce({ success: true });
    render(<DesktopShortcutsSection />);

    fireEvent.click(
      screen.getByRole("button", { name: "Record Push to talk shortcut" }),
    );
    fireEvent.keyDown(window, { key: "x", metaKey: true, shiftKey: true });

    await waitFor(() => {
      expect(bridge.request).toHaveBeenCalledWith({
        rpcMethod: "desktopRegisterShortcut",
        ipcChannel: "desktop:registerShortcut",
        params: { id: "push-to-talk", accelerator: "CommandOrControl+Shift+X" },
      });
      expect(shortcutStore.set).toHaveBeenCalledWith(
        "CommandOrControl+Shift+X",
      );
    });
    expect(screen.getByText("⌘ ⇧ X")).toBeTruthy();
  });

  it("keeps the saved shortcut when native registration rejects the replacement", async () => {
    bridge.request.mockResolvedValueOnce({ success: false });
    render(<DesktopShortcutsSection />);

    fireEvent.click(
      screen.getByRole("button", { name: "Record Push to talk shortcut" }),
    );
    fireEvent.keyDown(window, { key: "x", metaKey: true, shiftKey: true });

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain(
        "The operating system rejected CommandOrControl+Shift+X",
      );
    });
    expect(shortcutStore.set).not.toHaveBeenCalled();
    expect(screen.getByText("⌘ ⇧ Space")).toBeTruthy();
  });
});
