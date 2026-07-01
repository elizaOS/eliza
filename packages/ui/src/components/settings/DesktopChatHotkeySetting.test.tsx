// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DESKTOP_HOTKEY_STORAGE_KEY,
  loadDesktopHotkeySettings,
} from "../../utils/desktop-hotkey";

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

import { DesktopChatHotkeySetting } from "./DesktopChatHotkeySetting";

describe("DesktopChatHotkeySetting", () => {
  beforeEach(() => {
    localStorage.clear();
    invokeDesktopBridgeRequest.mockReset();
    invokeDesktopBridgeRequest.mockImplementation(async () => ({
      success: true,
    }));
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("shows the default accelerator and no reset button when unset", () => {
    render(<DesktopChatHotkeySetting platform="win32" />);
    // Pinned to win32 for a deterministic (glyph-free) display string.
    expect(screen.getByTestId("chat-hotkey-current").textContent).toBe(
      "Control+Shift+Space",
    );
    expect(screen.queryByTestId("chat-hotkey-reset")).toBeNull();
  });

  it("records a valid keystroke, registers it, persists it, and re-renders", async () => {
    render(<DesktopChatHotkeySetting platform="win32" />);
    fireEvent.click(screen.getByTestId("chat-hotkey-record"));
    expect(screen.getByTestId("chat-hotkey-current").textContent).toBe(
      "Press keys…",
    );

    await act(async () => {
      fireEvent.keyDown(window, {
        key: "j",
        code: "KeyJ",
        metaKey: true,
        shiftKey: true,
      });
      await Promise.resolve();
    });

    await waitFor(() =>
      expect(screen.getByTestId("chat-hotkey-current").textContent).toBe(
        "Command+Shift+J",
      ),
    );
    expect(loadDesktopHotkeySettings()).toEqual({
      chatSummonAccelerator: "Command+Shift+J",
    });
    expect(localStorage.getItem(DESKTOP_HOTKEY_STORAGE_KEY)).toContain(
      "Command+Shift+J",
    );
    expect(invokeDesktopBridgeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        rpcMethod: "desktopRegisterShortcut",
        params: { id: "summon-chat", accelerator: "Command+Shift+J" },
      }),
    );
  });

  it("rejects an unsafe (bare/Shift-only) keystroke while recording", () => {
    render(<DesktopChatHotkeySetting platform="win32" />);
    fireEvent.click(screen.getByTestId("chat-hotkey-record"));
    fireEvent.keyDown(window, { key: "k", code: "KeyK", shiftKey: true });
    expect(screen.getByRole("alert")).toBeTruthy();
    // Still recording, nothing persisted.
    expect(screen.getByTestId("chat-hotkey-current").textContent).toBe(
      "Press keys…",
    );
    expect(localStorage.getItem(DESKTOP_HOTKEY_STORAGE_KEY)).toBeNull();
  });

  it("cancels recording on Escape", () => {
    render(<DesktopChatHotkeySetting platform="win32" />);
    fireEvent.click(screen.getByTestId("chat-hotkey-record"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByTestId("chat-hotkey-current").textContent).toBe(
      "Control+Shift+Space",
    );
  });

  it("resets a custom accelerator back to the default", async () => {
    localStorage.setItem(
      DESKTOP_HOTKEY_STORAGE_KEY,
      JSON.stringify({ chatSummonAccelerator: "Command+Shift+J" }),
    );
    render(<DesktopChatHotkeySetting platform="win32" />);
    expect(screen.getByTestId("chat-hotkey-current").textContent).toBe(
      "Command+Shift+J",
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId("chat-hotkey-reset"));
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.getByTestId("chat-hotkey-current").textContent).toBe(
        "Control+Shift+Space",
      ),
    );
    expect(loadDesktopHotkeySettings()).toEqual({
      chatSummonAccelerator: null,
    });
  });

  it("surfaces an OS-rejected accelerator without persisting it", async () => {
    invokeDesktopBridgeRequest.mockImplementation(async (options) => {
      if (
        options.rpcMethod === "desktopRegisterShortcut" &&
        (options.params as { accelerator?: string } | undefined)
          ?.accelerator === "Command+Shift+J"
      ) {
        return { success: false };
      }
      return { success: true };
    });

    render(<DesktopChatHotkeySetting platform="win32" />);
    fireEvent.click(screen.getByTestId("chat-hotkey-record"));
    await act(async () => {
      fireEvent.keyDown(window, {
        key: "j",
        code: "KeyJ",
        metaKey: true,
        shiftKey: true,
      });
      await Promise.resolve();
    });

    expect(loadDesktopHotkeySettings()).toEqual({
      chatSummonAccelerator: null,
    });
    expect(screen.getByTestId("chat-hotkey-current").textContent).toBe(
      "Control+Shift+Space",
    );
    expect(
      await screen.findByText(
        "The operating system rejected Command+Shift+J. Choose a different shortcut.",
      ),
    ).toBeTruthy();
    expect(invokeDesktopBridgeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        rpcMethod: "desktopRegisterShortcut",
        params: { id: "summon-chat", accelerator: "Control+Shift+Space" },
      }),
    );
  });
});
