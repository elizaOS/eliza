/**
 * Covers the desktop shortcut recorder at its native registration boundary.
 * A rejected replacement must preserve the saved push-to-talk accelerator.
 */
// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopShortcutsSection } from "./DesktopShortcutsSection";

const bridge = vi.hoisted(() => ({ request: vi.fn() }));
const agentSurface = vi.hoisted(() => ({
  elements: new Map<
    string,
    { label: string; description?: string; onActivate?: () => void }
  >(),
}));
const shortcutStore = vi.hoisted(() => ({
  get: vi.fn(() => "CommandOrControl+Shift+Space"),
  set: vi.fn(),
}));

vi.mock("../../bridge", () => ({
  invokeDesktopBridgeRequest: bridge.request,
}));

vi.mock("../../agent-surface", () => ({
  useAgentElement: (options: {
    id: string;
    label: string;
    description?: string;
    onActivate?: () => void;
  }) => {
    agentSurface.elements.set(options.id, options);
    return { ref: null, agentProps: { "data-agent-id": options.id } };
  },
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
  agentSurface.elements.clear();
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

  it("treats a missing native registration method as a failed replacement", async () => {
    bridge.request.mockResolvedValueOnce(null);
    render(<DesktopShortcutsSection />);

    fireEvent.click(
      screen.getByRole("button", { name: "Record Push to talk shortcut" }),
    );
    fireEvent.keyDown(window, { key: "x", metaKey: true, shiftKey: true });

    await waitFor(() => {
      expect(screen.getByRole("alert").textContent).toContain(
        "The desktop app did not register CommandOrControl+Shift+X",
      );
    });
    expect(shortcutStore.set).not.toHaveBeenCalled();
    expect(screen.getByText("⌘ ⇧ Space")).toBeTruthy();
  });

  it("registers semantic, activatable record and reset controls on the Settings agent surface", async () => {
    render(<DesktopShortcutsSection />);

    const record = agentSurface.elements.get("shortcut-push-to-talk-record");
    const reset = agentSurface.elements.get("shortcut-push-to-talk-reset");
    expect(record?.label).toBe("Record Push to talk shortcut");
    expect(record?.description).toContain("Push to talk");
    expect(record?.onActivate).toBeTypeOf("function");
    expect(reset?.label).toBe("Reset Push to talk shortcut");
    expect(reset?.description).toContain("default keyboard shortcut");
    expect(
      screen
        .getByRole("button", { name: "Record Push to talk shortcut" })
        .getAttribute("data-agent-id"),
    ).toBe("shortcut-push-to-talk-record");

    await act(async () => record?.onActivate?.());
    expect(
      screen.getByRole("button", {
        name: "Cancel recording Push to talk shortcut",
      }),
    ).toBeTruthy();
  });

  it("serializes shortcut mutations triggered before React rerenders", async () => {
    let resolveRegistration: ((value: { success: true }) => void) | undefined;
    shortcutStore.get.mockReturnValue("CommandOrControl+X");
    bridge.request.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRegistration = resolve;
      }),
    );
    render(<DesktopShortcutsSection />);

    const reset = agentSurface.elements.get("shortcut-push-to-talk-reset");
    await act(async () => {
      reset?.onActivate?.();
      reset?.onActivate?.();
    });

    expect(bridge.request).toHaveBeenCalledTimes(1);
    resolveRegistration?.({ success: true });
    await waitFor(() => expect(shortcutStore.set).toHaveBeenCalledTimes(1));
  });
});
