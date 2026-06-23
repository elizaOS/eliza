/**
 * Unit tests for the structured screenshot error contract (#9105 M3.5).
 *
 * Verifies the code-classification mapping has a single source of truth and
 * that `tagScreenshotError` is purely additive — a `PermissionDeniedError`
 * keeps its identity while gaining a `screenshotErrorCode`.
 */

import { describe, expect, it } from "vitest";
import {
  createPermissionDeniedError,
  isPermissionDeniedError,
} from "../platform/permissions.js";
import {
  classifyScreenshotErrorCode,
  createScreenshotError,
  isScreenshotError,
  type ScreenshotErrorCode,
  tagScreenshotError,
} from "../platform/screenshot-errors.js";

describe("classifyScreenshotErrorCode", () => {
  it("maps a permission-denied error to permission_denied", () => {
    const err = createPermissionDeniedError({
      permissionType: "screen_recording",
      operation: "screenshot_capture",
      message: "Screen Recording permission required.",
    });
    expect(classifyScreenshotErrorCode(err)).toBe("permission_denied");
  });

  it("maps the Linux no-tool message to tool_missing", () => {
    const err = new Error(
      "No screenshot tool available. Install ImageMagick (import), scrot, or gnome-screenshot.",
    );
    expect(classifyScreenshotErrorCode(err)).toBe("tool_missing");
  });

  it("maps ENOENT (spawned tool not found) to tool_missing", () => {
    const err = new Error("spawn scrot ENOENT");
    expect(classifyScreenshotErrorCode(err)).toBe("tool_missing");
  });

  it("maps an empty-output message to empty_output", () => {
    expect(
      classifyScreenshotErrorCode(
        new Error("screencapture returned an empty file."),
      ),
    ).toBe("empty_output");
    expect(
      classifyScreenshotErrorCode(
        new Error("capture produced a zero-byte image"),
      ),
    ).toBe("empty_output");
  });

  it("maps timeout messages to timeout", () => {
    expect(classifyScreenshotErrorCode(new Error("Command timed out"))).toBe(
      "timeout",
    );
    expect(
      classifyScreenshotErrorCode(
        new Error("spawnSync screencapture ETIMEDOUT"),
      ),
    ).toBe("timeout");
  });

  it("falls back to capture_failed for unrecognized errors", () => {
    expect(classifyScreenshotErrorCode(new Error("something odd"))).toBe(
      "capture_failed",
    );
  });

  it("classifies a non-Error value as capture_failed", () => {
    expect(classifyScreenshotErrorCode("weird string failure")).toBe(
      "capture_failed",
    );
  });
});

describe("tagScreenshotError", () => {
  it("annotates an Error in place and preserves its identity", () => {
    const original = new Error("Command timed out");
    const tagged = tagScreenshotError(original, "screenshot_capture");
    expect(tagged).toBe(original); // same object — additive, not a wrapper
    expect(tagged.screenshotErrorCode).toBe("timeout");
    expect(tagged.operation).toBe("screenshot_capture");
    expect(isScreenshotError(tagged)).toBe(true);
  });

  it("keeps a PermissionDeniedError recognizable while adding the code", () => {
    const perm = createPermissionDeniedError({
      permissionType: "screen_recording",
      operation: "screenshot_capture",
      message: "Screen Recording permission required.",
    });
    const tagged = tagScreenshotError(perm, "screenshot_region");
    // Still a permission-denied error for existing callers...
    expect(isPermissionDeniedError(tagged)).toBe(true);
    // ...AND now also a screenshot error with the right code.
    expect(isScreenshotError(tagged)).toBe(true);
    expect(tagged.screenshotErrorCode).toBe("permission_denied");
    // The error carried its own operation, so it is not overwritten.
    expect(tagged.operation).toBe("screenshot_capture");
  });

  it("is idempotent", () => {
    const err = new Error("No screenshot tool available.");
    const once = tagScreenshotError(err, "screenshot_capture");
    const twice = tagScreenshotError(once, "screenshot_region");
    expect(twice).toBe(once);
    expect(twice.screenshotErrorCode).toBe("tool_missing");
    expect(twice.operation).toBe("screenshot_capture");
  });

  it("wraps a non-Error value in a fresh ScreenshotError", () => {
    const tagged = tagScreenshotError("kernel said no", "screenshot_capture");
    expect(isScreenshotError(tagged)).toBe(true);
    expect(tagged.screenshotErrorCode).toBe("capture_failed");
    expect(tagged.operation).toBe("screenshot_capture");
    expect(tagged.message).toBe("kernel said no");
  });

  it("defaults operation only when the error lacks one", () => {
    const noOp = new Error("boom");
    const tagged = tagScreenshotError(noOp, "screenshot_region");
    expect(tagged.operation).toBe("screenshot_region");
  });
});

describe("createScreenshotError / isScreenshotError", () => {
  it("builds a fully-formed ScreenshotError", () => {
    const err = createScreenshotError(
      "empty_output",
      "screenshot_capture",
      "empty image",
      "underlying detail",
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("ScreenshotError");
    expect(err.screenshotErrorCode).toBe("empty_output");
    expect(err.operation).toBe("screenshot_capture");
    expect(err.details).toBe("underlying detail");
    expect(isScreenshotError(err)).toBe(true);
  });

  it("rejects plain errors and non-errors from the type guard", () => {
    expect(isScreenshotError(new Error("plain"))).toBe(false);
    expect(isScreenshotError({ screenshotErrorCode: "timeout" })).toBe(false);
    expect(isScreenshotError(null)).toBe(false);
  });

  it("covers every declared error code", () => {
    const codes: ScreenshotErrorCode[] = [
      "permission_denied",
      "tool_missing",
      "empty_output",
      "timeout",
      "capture_failed",
    ];
    for (const code of codes) {
      const err = createScreenshotError(code, "op", `msg-${code}`);
      expect(err.screenshotErrorCode).toBe(code);
    }
  });
});
