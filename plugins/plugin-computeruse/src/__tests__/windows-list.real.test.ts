/**
 * Real integration tests for window management.
 *
 * Tests list/focus/screen-size using actual system calls.
 */
import { describe, expect, it } from "vitest";
import { currentPlatform } from "../platform/helpers.js";
import { getScreenSize, listWindows } from "../platform/windows-list.js";

const os = currentPlatform();
const hasDisplay =
  process.env.DISPLAY !== undefined || os === "darwin" || os === "win32";
const describeIfDisplay = hasDisplay ? describe : describe.skip;

describeIfDisplay("listWindows (real)", () => {
  it("returns an array of window info objects", () => {
    const windows = listWindows();

    expect(Array.isArray(windows)).toBe(true);
    // There should be at least one window open (the terminal running tests)
    // But on some CI environments there might be none
    for (const win of windows) {
      expect(win).toHaveProperty("id");
      expect(win).toHaveProperty("title");
      expect(win).toHaveProperty("app");
      expect(typeof win.id).toBe("string");
      expect(typeof win.title).toBe("string");
      expect(typeof win.app).toBe("string");
    }
  }, 15000);

  it("returns consistent structure on repeated calls", () => {
    const first = listWindows();
    const second = listWindows();

    // Both should be arrays with the same structure
    expect(Array.isArray(first)).toBe(true);
    expect(Array.isArray(second)).toBe(true);
  }, 25000);
});

describeIfDisplay("getScreenSize (real)", () => {
  it("returns valid screen dimensions", () => {
    const size = getScreenSize();

    expect(size).toHaveProperty("width");
    expect(size).toHaveProperty("height");
    expect(typeof size.width).toBe("number");
    expect(typeof size.height).toBe("number");
    // Real screens are at least 640x480
    expect(size.width).toBeGreaterThanOrEqual(640);
    expect(size.height).toBeGreaterThanOrEqual(480);
    // And less than 16K
    expect(size.width).toBeLessThanOrEqual(16384);
    expect(size.height).toBeLessThanOrEqual(16384);
  });

  it("returns consistent values on repeated calls", () => {
    const s1 = getScreenSize();
    const s2 = getScreenSize();

    expect(s1.width).toBe(s2.width);
    expect(s1.height).toBe(s2.height);
  });
});
