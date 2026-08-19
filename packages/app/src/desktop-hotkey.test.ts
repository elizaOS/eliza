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
  shouldEnableDesktopPushToTalk,
} from "./desktop-hotkey";

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
    expect(
      shouldEnableDesktopPushToTalk({
        platform: "darwin",
        surface: "bottom-bar",
      }),
    ).toBe(false);
  });

  it.each(["linux", "win32"] as const)(
    "preserves ambient PTT in a %s chat-overlay shell",
    (platform) => {
      expect(
        shouldEnableDesktopPushToTalk({ platform, surface: "bottom-bar" }),
      ).toBe(true);
    },
  );

  it("preserves ambient PTT for ordinary macOS workstation windows", () => {
    expect(
      shouldEnableDesktopPushToTalk({ platform: "darwin", surface: "default" }),
    ).toBe(true);
  });

  it("fails open for hosts without a typed native capability", () => {
    expect(shouldEnableDesktopPushToTalk(undefined)).toBe(true);
  });
});
