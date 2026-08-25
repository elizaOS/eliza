import { describe, expect, it } from "vitest";
import {
  FOCUSED_APP_SHELL_MODES,
  parseFocusedAppShellMode,
  resolveAppShellMode,
} from "./app-shell-mode.js";

describe("app-shell-mode", () => {
  it("parse returns mode for valid values", () => {
    for (const m of FOCUSED_APP_SHELL_MODES)
      expect(parseFocusedAppShellMode(m)).toBe(m);
  });

  it("parse returns null for invalid or empty", () => {
    expect(parseFocusedAppShellMode(null)).toBeNull();
    expect(parseFocusedAppShellMode(undefined)).toBeNull();
    expect(parseFocusedAppShellMode("")).toBeNull();
    expect(parseFocusedAppShellMode("full")).toBeNull();
    expect(parseFocusedAppShellMode("unknown")).toBeNull();
  });

  it("resolve prefers search param shellMode", () => {
    expect(resolveAppShellMode("?shellMode=chat-overlay", "")).toBe(
      "chat-overlay",
    );
    expect(resolveAppShellMode("?shell-mode=tray-popover", "")).toBe(
      "tray-popover",
    );
  });

  it("resolve falls back to hash and injectedMode then full", () => {
    expect(resolveAppShellMode("", "#?shellMode=voice-selftest")).toBe(
      "voice-selftest",
    );
    expect(resolveAppShellMode("", "", "launcher")).toBe("launcher");
    expect(resolveAppShellMode("", "")).toBe("full");
    expect(resolveAppShellMode("?shellMode=bad", "")).toBe("full");
  });
});
