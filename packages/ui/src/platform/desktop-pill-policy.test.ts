/** Verifies the desktop pill policy without a browser, native host, or voice runtime. */

import { describe, expect, it } from "vitest";
import { shouldUseClickOnlyChatOverlayPill } from "./desktop-pill-policy";

describe("shouldUseClickOnlyChatOverlayPill", () => {
  it("is click-only only for a native macOS host", () => {
    expect(
      shouldUseClickOnlyChatOverlayPill({
        platform: "darwin",
        surface: "bottom-bar",
      }),
    ).toBe(true);
    expect(
      shouldUseClickOnlyChatOverlayPill({
        platform: "darwin",
        surface: "default",
      }),
    ).toBe(false);
    expect(
      shouldUseClickOnlyChatOverlayPill({
        platform: "win32",
        surface: "bottom-bar",
      }),
    ).toBe(false);
    expect(shouldUseClickOnlyChatOverlayPill(undefined)).toBe(false);
  });
});
