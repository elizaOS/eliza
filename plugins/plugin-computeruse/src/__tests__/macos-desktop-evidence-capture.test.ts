/**
 * Classifier that maps macOS Accessibility/TCC blocker messages to
 * requires-device-evidence in the capture harness. Deterministic unit test.
 */
import { describe, expect, it } from "vitest";
import {
  isMacosAccessibilityEvidenceBlocker,
  startMacosBrowserEvidenceServer,
} from "../../scripts/capture-macos-desktop-evidence.mjs";

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

  it("serves the browser fixture only on ephemeral loopback and closes it", async () => {
    const fixture = await startMacosBrowserEvidenceServer();
    expect(fixture.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);

    const response = await fetch(fixture.url);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("macOS CUA Evidence");

    await fixture.close();
    await expect(
      fetch(fixture.url, { signal: AbortSignal.timeout(1_000) }),
    ).rejects.toThrow();
  });
});
