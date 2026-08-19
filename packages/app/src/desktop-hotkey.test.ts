/**
 * Unit tests for `decideChatOverlayToggle`, the desktop global-hotkey decision
 * that maps the chat overlay's {focused, visible} state to a `show`/`hide`
 * action: dismiss only when focused AND visible, otherwise summon (including
 * when the overlay is visible but backgrounded behind another app). Pure
 * function, called directly.
 */
import { describe, expect, it } from "vitest";
import {
  decideChatOverlayToggle,
  resolveDesktopHostPlatform,
  shouldEnableDesktopPushToTalk,
} from "./desktop-hotkey";

describe("resolveDesktopHostPlatform", () => {
  it.each([
    ["MacIntel", "darwin"],
    ["Win32", "win32"],
    ["Linux x86_64", "linux"],
    ["", "unknown"],
  ] as const)("maps %s to %s", (input, expected) => {
    expect(resolveDesktopHostPlatform(input)).toBe(expected);
  });
});

describe("decideChatOverlayToggle", () => {
  it("dismisses when the overlay is focused AND visible", () => {
    expect(decideChatOverlayToggle({ focused: true, visible: true })).toBe(
      "hide",
    );
  });

  it("summons when hidden", () => {
    expect(decideChatOverlayToggle({ focused: false, visible: false })).toBe(
      "show",
    );
    expect(decideChatOverlayToggle({ focused: true, visible: false })).toBe(
      "show",
    );
  });

  it("summons when visible but not focused (backgrounded behind another app)", () => {
    expect(decideChatOverlayToggle({ focused: false, visible: true })).toBe(
      "show",
    );
  });
});

describe("shouldEnableDesktopPushToTalk", () => {
  it("requires visible voice controls only in the macOS detached pill", () => {
    expect(shouldEnableDesktopPushToTalk(true, "darwin")).toBe(false);
  });

  it.each(["linux", "win32", "unknown"] as const)(
    "preserves ambient PTT in a %s chat-overlay shell",
    (platform) => {
      expect(shouldEnableDesktopPushToTalk(true, platform)).toBe(true);
    },
  );

  it("preserves ambient PTT for ordinary macOS workstation windows", () => {
    expect(shouldEnableDesktopPushToTalk(false, "darwin")).toBe(true);
  });
});
