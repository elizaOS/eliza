/**
 * Unit tests for `decideChatOverlayToggle`, the desktop global-hotkey decision
 * that maps the chat overlay's {focused, visible} state to a `show`/`hide`
 * action: dismiss only when focused AND visible, otherwise summon (including
 * when the overlay is visible but backgrounded behind another app). Pure
 * function, called directly.
 */
import { describe, expect, it } from "vitest";
import { decideChatOverlayToggle } from "./desktop-hotkey";

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
