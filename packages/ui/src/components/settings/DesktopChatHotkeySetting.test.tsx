// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DESKTOP_HOTKEY_STORAGE_KEY,
  loadDesktopHotkeySettings,
} from "../../utils/desktop-hotkey";
import { DesktopChatHotkeySetting } from "./DesktopChatHotkeySetting";

describe("DesktopChatHotkeySetting", () => {
  beforeEach(() => {
    localStorage.clear();
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

  it("records a valid keystroke, persists it, and re-renders", () => {
    render(<DesktopChatHotkeySetting platform="win32" />);
    fireEvent.click(screen.getByTestId("chat-hotkey-record"));
    expect(screen.getByTestId("chat-hotkey-current").textContent).toBe(
      "Press keys…",
    );

    fireEvent.keyDown(window, {
      key: "j",
      code: "KeyJ",
      metaKey: true,
      shiftKey: true,
    });

    expect(screen.getByTestId("chat-hotkey-current").textContent).toBe(
      "Command+Shift+J",
    );
    expect(loadDesktopHotkeySettings()).toEqual({
      chatSummonAccelerator: "Command+Shift+J",
    });
    expect(localStorage.getItem(DESKTOP_HOTKEY_STORAGE_KEY)).toContain(
      "Command+Shift+J",
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

  it("resets a custom accelerator back to the default", () => {
    localStorage.setItem(
      DESKTOP_HOTKEY_STORAGE_KEY,
      JSON.stringify({ chatSummonAccelerator: "Command+Shift+J" }),
    );
    render(<DesktopChatHotkeySetting platform="win32" />);
    expect(screen.getByTestId("chat-hotkey-current").textContent).toBe(
      "Command+Shift+J",
    );
    fireEvent.click(screen.getByTestId("chat-hotkey-reset"));
    expect(screen.getByTestId("chat-hotkey-current").textContent).toBe(
      "Control+Shift+Space",
    );
    expect(loadDesktopHotkeySettings()).toEqual({
      chatSummonAccelerator: null,
    });
  });
});
