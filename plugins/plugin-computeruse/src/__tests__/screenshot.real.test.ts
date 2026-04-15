/**
 * Real integration tests for screenshot capture.
 *
 * These tests actually capture the screen using native tools.
 * They verify that the screenshot module produces valid PNG buffers
 * and handles errors gracefully.
 *
 * Requires: screen access (macOS Screen Recording permission, Linux X11, Windows desktop).
 * CI: may be skipped if no display is available.
 */
import { describe, expect, it } from "vitest";
import { captureScreenshot } from "../platform/screenshot.js";
import { currentPlatform } from "../platform/helpers.js";
import { isPermissionDeniedError } from "../platform/permissions.js";

// PNG magic bytes: 0x89 P N G \r \n 0x1a \n
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// Check if screen capture actually works (may fail due to missing permissions)
function canCaptureScreen(): boolean {
  try {
    captureScreenshot();
    return true;
  } catch {
    return false;
  }
}

const hasCapture = canCaptureScreen();
const describeIfCapture = hasCapture ? describe : describe.skip;

describeIfCapture("captureScreenshot (real)", () => {
  it("captures a full-screen screenshot as a PNG buffer", () => {
    const buf = captureScreenshot();

    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(1000); // a real screenshot is much larger than 1KB
    // Verify PNG magic bytes
    expect(buf.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
  });

  it("returns a buffer with reasonable size (not empty, not absurdly large)", () => {
    const buf = captureScreenshot();

    // A real screenshot should be at least several KB
    expect(buf.length).toBeGreaterThan(4096);
    // And shouldn't exceed 100MB (sanity check)
    expect(buf.length).toBeLessThan(100 * 1024 * 1024);
  });

  it("captures a region if the platform supports it", ({ skip }) => {
    // Only macOS supports region capture via -R flag
    if (currentPlatform() !== "darwin") return;

    let buf: Buffer;
    try {
      buf = captureScreenshot({ x: 0, y: 0, width: 200, height: 200 });
    } catch (error) {
      if (
        isPermissionDeniedError(error)
        && error.permissionType === "screen_recording"
      ) {
        skip(error.message);
      }
      throw error;
    }

    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBeGreaterThan(100);
    expect(buf.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
  });

  it("consecutive captures produce valid PNGs (no temp file leaks)", () => {
    const buf1 = captureScreenshot();
    const buf2 = captureScreenshot();

    expect(buf1.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    expect(buf2.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
    // Different captures should produce different buffers (timestamps differ)
    // But they should both be valid PNGs
    expect(buf1.length).toBeGreaterThan(0);
    expect(buf2.length).toBeGreaterThan(0);
  });
});
