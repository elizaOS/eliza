import { describe, expect, it } from "vitest";
import { shouldCreateDesktopPill } from "./desktop-pill-config";

describe("desktop pill config", () => {
  it("creates a pill window by default (voice surface)", () => {
    expect(shouldCreateDesktopPill({})).toBe(true);
  });

  it("supports an explicit enable flag", () => {
    expect(shouldCreateDesktopPill({ ELIZA_DESKTOP_PILL: "1" })).toBe(true);
    expect(shouldCreateDesktopPill({ ELIZA_DESKTOP_PILL: "true" })).toBe(true);
    expect(shouldCreateDesktopPill({ ELIZA_DESKTOP_PILL: "yes" })).toBe(true);
  });

  it("supports explicit negative and disable flags", () => {
    expect(shouldCreateDesktopPill({ ELIZA_DESKTOP_PILL: "0" })).toBe(false);
    expect(shouldCreateDesktopPill({ ELIZA_DESKTOP_PILL: "false" })).toBe(
      false,
    );
    expect(
      shouldCreateDesktopPill({
        ELIZA_DESKTOP_PILL: "1",
        ELIZA_DESKTOP_DISABLE_PILL: "1",
      }),
    ).toBe(false);
  });
});
