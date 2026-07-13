// @vitest-environment jsdom

/**
 * Covers the desktop hotkey settings groups (chat summon, voice conversation,
 * transcribe): default accelerator + enabled toggle, disabling (persist +
 * unregister shortcut), recording a keystroke to rebind, Escape-cancels-
 * recording, and surfacing an OS-rejected accelerator without persisting.
 * jsdom render with the desktop bridge mocked and the real hotkey stores.
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
  DEFAULT_TRANSCRIBE_HOTKEY_ACCELERATOR,
  DEFAULT_VOICE_HOTKEY_ACCELERATOR,
  getTranscribeHotkey,
  getVoiceHotkey,
  setTranscribeHotkey,
  setVoiceHotkey,
} from "../../state/desktop-hotkeys";
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

import {
  ChatHotkeySettingsGroup,
  TranscribeHotkeySettingsGroup,
  VoiceHotkeySettingsGroup,
} from "./ChatHotkeySettingsGroup";

function seed() {
  __setAppValueForTests({
    t: (_key: string, opts?: { defaultValue?: string }) =>
      opts?.defaultValue ?? _key,
    setState: vi.fn(),
  } as never);
}

beforeEach(() => {
  window.localStorage.clear();
  // Reset the module-level hotkey stores to their defaults before each test —
  // their cached snapshots survive a localStorage.clear() on their own.
  setChatOverlayHotkey({
    accelerator: DEFAULT_CHAT_OVERLAY_ACCELERATOR,
    enabled: true,
  });
  setVoiceHotkey({
    accelerator: DEFAULT_VOICE_HOTKEY_ACCELERATOR,
    enabled: true,
  });
  setTranscribeHotkey({
    accelerator: DEFAULT_TRANSCRIBE_HOTKEY_ACCELERATOR,
    enabled: false,
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

describe("VoiceHotkeySettingsGroup", () => {
  it("renders the default accelerator with the toggle ON (voice is on by default)", () => {
    render(<VoiceHotkeySettingsGroup />);
    expect(screen.getByText("CommandOrControl+Shift+M")).toBeTruthy();
    const sw = screen.getByRole("switch") as HTMLButtonElement;
    expect(sw.getAttribute("data-state")).toBe("checked");
  });

  it("recording a keystroke rebinds and re-registers the `voice` shortcut id", async () => {
    render(<VoiceHotkeySettingsGroup />);
    act(() => {
      fireEvent.click(screen.getByText("Record"));
    });
    await act(async () => {
      fireEvent.keyDown(window, { key: "m", ctrlKey: true, altKey: true });
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getVoiceHotkey().accelerator).toBe("CommandOrControl+Alt+M");
    expect(invokeDesktopBridgeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        rpcMethod: "desktopUnregisterShortcut",
        params: { id: "voice" },
      }),
    );
    expect(invokeDesktopBridgeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        rpcMethod: "desktopRegisterShortcut",
        params: { id: "voice", accelerator: "CommandOrControl+Alt+M" },
      }),
    );
  });

  it("disabling the toggle persists disabled and unregisters only", async () => {
    render(<VoiceHotkeySettingsGroup />);
    const sw = screen.getByRole("switch") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(sw);
      await Promise.resolve();
    });
    expect(getVoiceHotkey().enabled).toBe(false);
    expect(invokeDesktopBridgeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        rpcMethod: "desktopUnregisterShortcut",
        params: { id: "voice" },
      }),
    );
    expect(invokeDesktopBridgeRequest).not.toHaveBeenCalledWith(
      expect.objectContaining({ rpcMethod: "desktopRegisterShortcut" }),
    );
  });
});

describe("TranscribeHotkeySettingsGroup", () => {
  it("renders the default accelerator with the toggle OFF (transcribe is opt-in)", () => {
    render(<TranscribeHotkeySettingsGroup />);
    expect(screen.getByText("CommandOrControl+Alt+T")).toBeTruthy();
    const sw = screen.getByRole("switch") as HTMLButtonElement;
    expect(sw.getAttribute("data-state")).toBe("unchecked");
    // The recorder is disabled while the hotkey is off.
    const record = screen.getByText("Record") as HTMLButtonElement;
    expect(record.closest("button")?.disabled).toBe(true);
  });

  it("enabling the toggle registers the `transcribe` shortcut with the default accelerator", async () => {
    render(<TranscribeHotkeySettingsGroup />);
    const sw = screen.getByRole("switch") as HTMLButtonElement;
    await act(async () => {
      fireEvent.click(sw);
      await Promise.resolve();
    });
    expect(getTranscribeHotkey().enabled).toBe(true);
    expect(invokeDesktopBridgeRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        rpcMethod: "desktopRegisterShortcut",
        params: { id: "transcribe", accelerator: "CommandOrControl+Alt+T" },
      }),
    );
  });
});
