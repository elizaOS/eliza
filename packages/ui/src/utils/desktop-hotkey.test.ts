import { describe, expect, it } from "vitest";
import {
  DEFAULT_DESKTOP_HOTKEY_SETTINGS,
  defaultChatSummonAccelerator,
  isSafeGlobalAccelerator,
  isValidAccelerator,
  normalizeAccelerator,
  parseDesktopHotkeySettings,
  resolveChatSummonAccelerator,
  serializeDesktopHotkeySettings,
  SUMMON_CHAT_SHORTCUT_ID,
} from "./desktop-hotkey";

describe("defaultChatSummonAccelerator", () => {
  it("uses Command+Shift+Space on macOS (distinct from Spotlight / ⌘K)", () => {
    expect(defaultChatSummonAccelerator("darwin")).toBe("Command+Shift+Space");
  });

  it("uses Control+Shift+Space off macOS", () => {
    expect(defaultChatSummonAccelerator("win32")).toBe("Control+Shift+Space");
    expect(defaultChatSummonAccelerator("linux")).toBe("Control+Shift+Space");
  });

  it("never collides with the command-palette binding", () => {
    for (const platform of ["darwin", "win32", "linux"] as const) {
      expect(defaultChatSummonAccelerator(platform)).not.toBe(
        "CommandOrControl+K",
      );
    }
  });
});

describe("normalizeAccelerator", () => {
  it("canonicalizes modifier aliases and casing", () => {
    expect(normalizeAccelerator("cmd+shift+space")).toBe("Command+Shift+Space");
    expect(normalizeAccelerator("CmdOrCtrl+k")).toBe("CommandOrControl+K");
    expect(normalizeAccelerator("option+Enter")).toBe("Alt+Enter");
    expect(normalizeAccelerator("meta+j")).toBe("Super+J");
  });

  it("orders modifiers canonically so equivalent strings compare equal", () => {
    expect(normalizeAccelerator("Shift+Command+K")).toBe("Command+Shift+K");
    expect(normalizeAccelerator("Command+Shift+K")).toBe("Command+Shift+K");
    expect(normalizeAccelerator("Alt+Control+F5")).toBe("Control+Alt+F5");
  });

  it("accepts function keys F1–F24", () => {
    expect(normalizeAccelerator("Command+F12")).toBe("Command+F12");
    expect(normalizeAccelerator("Control+F24")).toBe("Control+F24");
    expect(normalizeAccelerator("Command+F25")).toBeNull();
    expect(normalizeAccelerator("Command+F0")).toBeNull();
  });

  it("rejects empty, whitespace, and malformed input", () => {
    expect(normalizeAccelerator("")).toBeNull();
    expect(normalizeAccelerator("   ")).toBeNull();
    expect(normalizeAccelerator("Command+")).toBeNull();
    expect(normalizeAccelerator("+K")).toBeNull();
    expect(normalizeAccelerator(null)).toBeNull();
    expect(normalizeAccelerator(undefined)).toBeNull();
  });

  it("rejects a modifier-only accelerator (no key)", () => {
    expect(normalizeAccelerator("Command+Shift")).toBeNull();
    expect(normalizeAccelerator("Control")).toBeNull();
  });

  it("rejects two keys or unknown tokens", () => {
    expect(normalizeAccelerator("Command+K+J")).toBeNull();
    expect(normalizeAccelerator("Command+Frobnicate")).toBeNull();
    expect(normalizeAccelerator("Hyper+K")).toBeNull();
  });

  it("rejects duplicate modifiers", () => {
    expect(normalizeAccelerator("Command+Command+K")).toBeNull();
  });
});

describe("isValidAccelerator", () => {
  it("mirrors normalizeAccelerator success/failure", () => {
    expect(isValidAccelerator("Command+Shift+Space")).toBe(true);
    expect(isValidAccelerator("nope")).toBe(false);
  });
});

describe("isSafeGlobalAccelerator", () => {
  it("accepts accelerators with a non-Shift modifier", () => {
    expect(isSafeGlobalAccelerator("Command+Shift+Space")).toBe(true);
    expect(isSafeGlobalAccelerator("Control+J")).toBe(true);
    expect(isSafeGlobalAccelerator("Alt+Space")).toBe(true);
  });

  it("rejects bare keys and Shift-only accelerators (would hijack typing)", () => {
    expect(isSafeGlobalAccelerator("K")).toBe(false);
    expect(isSafeGlobalAccelerator("Shift+K")).toBe(false);
    expect(isSafeGlobalAccelerator("Space")).toBe(false);
  });

  it("rejects invalid accelerators", () => {
    expect(isSafeGlobalAccelerator("")).toBe(false);
    expect(isSafeGlobalAccelerator("Command+")).toBe(false);
  });
});

describe("parseDesktopHotkeySettings", () => {
  it("defaults on missing / non-object / corrupt input", () => {
    expect(parseDesktopHotkeySettings(undefined)).toEqual(
      DEFAULT_DESKTOP_HOTKEY_SETTINGS,
    );
    expect(parseDesktopHotkeySettings(null)).toEqual(
      DEFAULT_DESKTOP_HOTKEY_SETTINGS,
    );
    expect(parseDesktopHotkeySettings("garbage")).toEqual(
      DEFAULT_DESKTOP_HOTKEY_SETTINGS,
    );
    expect(parseDesktopHotkeySettings(42)).toEqual(
      DEFAULT_DESKTOP_HOTKEY_SETTINGS,
    );
  });

  it("normalizes a valid stored accelerator", () => {
    expect(
      parseDesktopHotkeySettings({ chatSummonAccelerator: "shift+cmd+j" }),
    ).toEqual({ chatSummonAccelerator: "Command+Shift+J" });
  });

  it("drops an invalid or unsafe stored accelerator back to default", () => {
    expect(
      parseDesktopHotkeySettings({ chatSummonAccelerator: "not-a-key" }),
    ).toEqual({ chatSummonAccelerator: null });
    expect(
      parseDesktopHotkeySettings({ chatSummonAccelerator: "Shift+K" }),
    ).toEqual({ chatSummonAccelerator: null });
    expect(parseDesktopHotkeySettings({ chatSummonAccelerator: 5 })).toEqual({
      chatSummonAccelerator: null,
    });
  });
});

describe("serializeDesktopHotkeySettings", () => {
  it("round-trips through parse", () => {
    const settings = { chatSummonAccelerator: "Command+Shift+J" };
    const json = serializeDesktopHotkeySettings(settings);
    expect(parseDesktopHotkeySettings(JSON.parse(json))).toEqual(settings);
  });

  it("normalizes on the way out and ends with a trailing newline", () => {
    const json = serializeDesktopHotkeySettings({
      chatSummonAccelerator: "shift+cmd+j",
    });
    expect(JSON.parse(json)).toEqual({
      chatSummonAccelerator: "Command+Shift+J",
    });
    expect(json.endsWith("\n")).toBe(true);
  });

  it("serializes the default (null) accelerator", () => {
    const json = serializeDesktopHotkeySettings({ chatSummonAccelerator: null });
    expect(JSON.parse(json)).toEqual({ chatSummonAccelerator: null });
  });
});

describe("resolveChatSummonAccelerator", () => {
  it("returns the per-platform default when no override is set", () => {
    expect(
      resolveChatSummonAccelerator({ chatSummonAccelerator: null }, "darwin"),
    ).toBe("Command+Shift+Space");
    expect(
      resolveChatSummonAccelerator({ chatSummonAccelerator: null }, "linux"),
    ).toBe("Control+Shift+Space");
  });

  it("returns a valid, normalized override", () => {
    expect(
      resolveChatSummonAccelerator(
        { chatSummonAccelerator: "shift+cmd+j" },
        "darwin",
      ),
    ).toBe("Command+Shift+J");
  });

  it("falls back to default for an unsafe override", () => {
    expect(
      resolveChatSummonAccelerator({ chatSummonAccelerator: "Shift+K" }, "darwin"),
    ).toBe("Command+Shift+Space");
  });
});

describe("SUMMON_CHAT_SHORTCUT_ID", () => {
  it("is stable and not the command-palette id", () => {
    expect(SUMMON_CHAT_SHORTCUT_ID).toBe("summon-chat");
    expect(SUMMON_CHAT_SHORTCUT_ID).not.toBe("command-palette");
  });
});
