// @vitest-environment jsdom

/**
 * Covers ChatHotkeySettingsGroup: default accelerator + enabled toggle,
 * disabling (persist + unregister shortcut), recording a keystroke to rebind,
 * Escape-cancels-recording, and surfacing an OS-rejected accelerator without
 * persisting. jsdom render with the desktop bridge mocked and the real hotkey
 * store.
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __setAppValueForTests } from "../../state/app-store";
import {
  DEFAULT_CHAT_OVERLAY_ACCELERATOR,
  getChatOverlayHotkey,
  setChatOverlayHotkey,
} from "../../state/useChatOverlayHotkey";

const invokeDesktopBridgeRequest = vi.fn(
  async (_options: {
    rpcMethod: string;
    ipcChannel: string;
    params?: unknown;
  }) => ({ success: true }),
);
vi.mock("../../bridge", () => ({
  invokeDesktopBridgeRequest: (options: {
    rpcMethod: string;
    ipcChannel: string;
    params?: unknown;
  }) => invokeDesktopBridgeRequest(options),
}));

import { ChatHotkeySettingsGroup } from "./ChatHotkeySettingsGroup";

function seed() {
  __setAppValueForTests({
    t: (_key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? _key,
    setState: vi.fn(),
  } as never);
}

beforeEach(() => {
  window.localStorage.clear();
  // Reset the module-level hotkey store to the default before each test — its
  // cached snapshot survives a localStorage.clear() on its own.
  setChatOverlayHotkey({
    accelerator: DEFAULT_CHAT_OVERLAY_ACCELERATOR,
    enabled: true,
  });
  invokeDesktopBridgeRequest.mockReset();
  invokeDesktopBridgeRequest.mockImplementation(async () => ({
    success: true,
  }));
  seed();
});

afterEach(() => {
  cleanup();
  __setAppValueForTests(null);
  window.localStorage.clear();
});

describe("ChatHotkeySettingsGroup", () => {
  it("renders the default accelerator and an enabled toggle", () => {
    render(<ChatHotkeySettingsGroup />);
    expect(screen.getByText("CommandOrControl+Shift+C")).toBeTruthy();
    const sw = screen.getByRole("switch") as HTMLButtonElement;
    expect(sw.getAttribute("data-state")).toBe("checked");
  });

  it("disabling the toggle persists disabled and unregisters the shortcut", async () => {
    render(<ChatHotkeySettingsGroup />);
    const sw = screen.getByRole("switch") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(sw);
      await Promise.resolve();
    });
    expect(getChatOverlayHotkey().enabled).toBe(false);
    // Disabling only unregisters — no re-register call.
    expect(invokeDesktopBridgeRequest).toHaveBeenCalledWith(
      expect.objectContaining({ rpcMethod: "desktopUnregisterShortcut" }),
    );
    expect(invokeDesktopBridgeRequest).not.toHaveBeenCalledWith(
      expect.objectContaining({ rpcMethod: "desktopRegisterShortcut" }),
    );
  });

  it("recording a keystroke rebinds and re-registers the accelerator", async () => {
    render(<ChatHotkeySettingsGroup />);
    act(() => {
      fireEvent.click(screen.getByText("Record"));
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: "j", ctrlKey: true });
      // Flush the async unregister→register bridge sequence.
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getChatOverlayHotkey().accelerator).toBe("CommandOrControl+J");
    expect(invokeDesktopBridgeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        rpcMethod: "desktopRegisterShortcut",
        params: { id: "chat-overlay", accelerator: "CommandOrControl+J" },
      }),
    );
  });

  it("Escape cancels recording without changing the accelerator", () => {
    render(<ChatHotkeySettingsGroup />);
    act(() => {
      fireEvent.click(screen.getByText("Record"));
    });
    act(() => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(getChatOverlayHotkey().accelerator).toBe("CommandOrControl+Shift+C");
    expect(screen.getByText("Record")).toBeTruthy();
  });

  it("surfaces an OS-rejected accelerator without persisting it", async () => {
    invokeDesktopBridgeRequest.mockImplementation(async (options) => {
      if (options.rpcMethod === "desktopRegisterShortcut") {
        return { success: false };
      }
      return { success: true };
    });

    render(<ChatHotkeySettingsGroup />);
    act(() => {
      fireEvent.click(screen.getByText("Record"));
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: "j", ctrlKey: true });
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(getChatOverlayHotkey().accelerator).toBe(
      DEFAULT_CHAT_OVERLAY_ACCELERATOR,
    );
    expect(
      screen.getByText(
        "The operating system rejected CommandOrControl+J. Choose a different shortcut.",
      ),
    ).toBeTruthy();
  });
});
