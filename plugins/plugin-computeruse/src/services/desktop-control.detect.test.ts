/**
 * Capability detection tests pin the desktop-control report consumed before
 * computer-use capture or input dispatch attempts real platform work.
 *
 * The detector must degrade gracefully on headless CI hosts while staying
 * internally consistent across Linux, macOS, and Windows capability fields.
 */
import { describe, expect, it } from "vitest";
import {
  type DesktopControlCapability,
  detectDesktopControlCapabilities,
  isHeadfulGuiAvailable,
} from "./desktop-control.js";

const isCap = (c: DesktopControlCapability) => {
  expect(typeof c.available).toBe("boolean");
  expect(typeof c.tool).toBe("string");
  expect(c.tool.length).toBeGreaterThan(0);
};

describe("detectDesktopControlCapabilities", () => {
  it("returns a fully-populated, well-typed capability report", () => {
    const caps = detectDesktopControlCapabilities();
    for (const c of [
      caps.headfulGui,
      caps.screenshot,
      caps.computerUse,
      caps.windowList,
    ]) {
      isCap(c);
    }
  });

  it("reflects isHeadfulGuiAvailable() in the headfulGui capability", () => {
    expect(detectDesktopControlCapabilities().headfulGui.available).toBe(
      isHeadfulGuiAvailable(),
    );
  });

  it("never claims screenshot capability on a headless Linux host", () => {
    if (process.platform !== "linux") return;
    const caps = detectDesktopControlCapabilities();
    if (!caps.headfulGui.available) {
      expect(caps.screenshot.available).toBe(false);
    }
  });
});

describe("isHeadfulGuiAvailable", () => {
  it("returns a boolean and is true whenever a Linux display var is set", () => {
    const result = isHeadfulGuiAvailable();
    expect(typeof result).toBe("boolean");
    if (process.platform === "linux") {
      const hasDisplay = Boolean(
        process.env.DISPLAY?.trim() || process.env.WAYLAND_DISPLAY?.trim(),
      );
      if (hasDisplay) expect(result).toBe(true);
    }
  });
});
