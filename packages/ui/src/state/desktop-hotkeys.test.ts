// @vitest-environment jsdom

/**
 * Pins the desktop global-hotkey defaults and the keyed-store contract: chat
 * summon ON by default with its historical storage key (persisted settings must
 * survive the store generalization), voice ON by default, transcribe OFF by
 * default, and no two shortcuts sharing an accelerator. Pure store logic — no
 * DOM harness beyond jsdom localStorage.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  createDesktopHotkeyStore,
  DEFAULT_TRANSCRIBE_HOTKEY_ACCELERATOR,
  DEFAULT_VOICE_HOTKEY_ACCELERATOR,
  getTranscribeHotkey,
  getVoiceHotkey,
  TRANSCRIBE_HOTKEY_STORAGE_KEY,
  TRANSCRIBE_SHORTCUT_ID,
  VOICE_HOTKEY_STORAGE_KEY,
  VOICE_SHORTCUT_ID,
  voiceHotkeyStore,
} from "./desktop-hotkeys";
import {
  chatOverlayHotkeyStore,
  DEFAULT_CHAT_OVERLAY_ACCELERATOR,
  getChatOverlayHotkey,
  setChatOverlayHotkey,
} from "./useChatOverlayHotkey";

beforeEach(() => {
  window.localStorage.clear();
  // The module-level stores cache their snapshot; reset each to its default so
  // a prior test's set() cannot leak across cases.
  chatOverlayHotkeyStore.set(chatOverlayHotkeyStore.defaultHotkey);
  voiceHotkeyStore.set(voiceHotkeyStore.defaultHotkey);
});

describe("desktop hotkey defaults (regression pins)", () => {
  it("chat summon is ON by default at CommandOrControl+Shift+C", () => {
    expect(getChatOverlayHotkey()).toEqual({
      accelerator: "CommandOrControl+Shift+C",
      enabled: true,
    });
    expect(DEFAULT_CHAT_OVERLAY_ACCELERATOR).toBe("CommandOrControl+Shift+C");
  });

  it("chat keeps its historical storage key so persisted settings survive", () => {
    setChatOverlayHotkey({ accelerator: "CommandOrControl+J" });
    expect(chatOverlayHotkeyStore.storageKey).toBe("eliza:chatOverlayHotkey");
    expect(
      JSON.parse(
        window.localStorage.getItem("eliza:chatOverlayHotkey") ?? "null",
      ),
    ).toEqual({ accelerator: "CommandOrControl+J", enabled: true });
  });

  it("voice conversation toggle is ON by default at CommandOrControl+Shift+M", () => {
    expect(getVoiceHotkey()).toEqual({
      accelerator: "CommandOrControl+Shift+M",
      enabled: true,
    });
    expect(DEFAULT_VOICE_HOTKEY_ACCELERATOR).toBe("CommandOrControl+Shift+M");
    expect(VOICE_HOTKEY_STORAGE_KEY).toBe("eliza:voiceHotkey");
    expect(VOICE_SHORTCUT_ID).toBe("voice");
  });

  it("transcribe toggle is OFF by default at CommandOrControl+Alt+T", () => {
    expect(getTranscribeHotkey()).toEqual({
      accelerator: "CommandOrControl+Alt+T",
      enabled: false,
    });
    expect(DEFAULT_TRANSCRIBE_HOTKEY_ACCELERATOR).toBe(
      "CommandOrControl+Alt+T",
    );
    expect(TRANSCRIBE_HOTKEY_STORAGE_KEY).toBe("eliza:transcribeHotkey");
    expect(TRANSCRIBE_SHORTCUT_ID).toBe("transcribe");
  });

  it("no two default accelerators collide (all three register together)", () => {
    const accelerators = [
      DEFAULT_CHAT_OVERLAY_ACCELERATOR,
      DEFAULT_VOICE_HOTKEY_ACCELERATOR,
      DEFAULT_TRANSCRIBE_HOTKEY_ACCELERATOR,
      // The command palette's fixed binding must stay clear of all of them.
      "CommandOrControl+K",
    ];
    expect(new Set(accelerators).size).toBe(accelerators.length);
  });
});

describe("createDesktopHotkeyStore", () => {
  it("honors defaultEnabled=false for missing/malformed persisted state", () => {
    const store = createDesktopHotkeyStore({
      storageKey: "eliza:test-hotkey-a",
      defaultAccelerator: "CommandOrControl+F9",
      defaultEnabled: false,
    });
    expect(store.resolve(null)).toEqual({
      accelerator: "CommandOrControl+F9",
      enabled: false,
    });
    expect(store.resolve({ accelerator: "" })).toEqual({
      accelerator: "CommandOrControl+F9",
      enabled: false,
    });
  });

  it("set() persists, normalizes, and notifies subscribers once per change", () => {
    const store = createDesktopHotkeyStore({
      storageKey: "eliza:test-hotkey-b",
      defaultAccelerator: "CommandOrControl+F10",
      defaultEnabled: true,
    });
    let notified = 0;
    const unsubscribe = store.subscribe(() => {
      notified += 1;
    });
    store.set({ accelerator: " Alt + Space ", enabled: false });
    expect(store.get()).toEqual({ accelerator: "Alt+Space", enabled: false });
    expect(
      JSON.parse(window.localStorage.getItem("eliza:test-hotkey-b") ?? "null"),
    ).toEqual({ accelerator: "Alt+Space", enabled: false });
    // Identical set() is a no-op notification-wise.
    store.set({ accelerator: "Alt+Space", enabled: false });
    expect(notified).toBe(1);
    unsubscribe();
  });

  it("reads persisted state lazily created before the store", () => {
    window.localStorage.setItem(
      "eliza:test-hotkey-c",
      JSON.stringify({ accelerator: "CommandOrControl+F11", enabled: false }),
    );
    const store = createDesktopHotkeyStore({
      storageKey: "eliza:test-hotkey-c",
      defaultAccelerator: "CommandOrControl+F12",
      defaultEnabled: true,
    });
    expect(store.get()).toEqual({
      accelerator: "CommandOrControl+F11",
      enabled: false,
    });
  });
});
