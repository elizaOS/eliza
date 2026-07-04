/**
 * Classifier that maps macOS Accessibility/TCC blocker messages to
 * requires-device-evidence in the capture harness. Deterministic unit test.
 */
import { describe, expect, it } from "vitest";
import { isMacosAccessibilityEvidenceBlocker } from "../../scripts/capture-macos-desktop-evidence.mjs";

describe("macOS desktop evidence capture", () => {
  it("classifies known Accessibility/TCC blockers as missing device evidence", () => {
    expect(
      isMacosAccessibilityEvidenceBlocker(
        "list_windows returned only placeholder window metadata; grant Accessibility permission in System Settings > Privacy & Security > Accessibility, then retry",
      ),
    ).toBe(true);
    expect(
      isMacosAccessibilityEvidenceBlocker("spawnSync osascript ETIMEDOUT"),
    ).toBe(true);
    expect(
      isMacosAccessibilityEvidenceBlocker(
        "could not read TextEdit bounds: Window not found; listWindows could not resolve the TextEdit window",
      ),
    ).toBe(true);
  });

  it("keeps unrelated capture failures as hard failures", () => {
    expect(
      isMacosAccessibilityEvidenceBlocker(
        "browser_screenshot failed: target closed unexpectedly",
      ),
    ).toBe(false);
    expect(
      isMacosAccessibilityEvidenceBlocker(
        "primary display screenshot: screenshot quality failed",
      ),
    ).toBe(false);
  });
});
