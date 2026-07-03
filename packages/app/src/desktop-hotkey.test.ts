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
