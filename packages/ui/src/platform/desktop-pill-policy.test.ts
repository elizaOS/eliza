/** Verifies the desktop pill policy without a browser, native host, or voice runtime. */

import { describe, expect, it } from "vitest";
import { shouldUseClickOnlyChatOverlayPill } from "./desktop-pill-policy";

describe("shouldUseClickOnlyChatOverlayPill", () => {
  it("is click-only only for a native macOS host", () => {
    expect(shouldUseClickOnlyChatOverlayPill(true, "MacIntel")).toBe(true);
    expect(shouldUseClickOnlyChatOverlayPill(false, "MacIntel")).toBe(false);
    expect(shouldUseClickOnlyChatOverlayPill(true, "Win32")).toBe(false);
    expect(shouldUseClickOnlyChatOverlayPill(true, "Linux x86_64")).toBe(false);
  });
});
