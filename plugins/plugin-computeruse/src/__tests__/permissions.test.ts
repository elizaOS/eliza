/**
 * Permission helper tests for macOS Accessibility and Screen Recording.
 *
 * These tests validate structured denial detection and the translated
 * desktop/screenshot errors without requiring real macOS permission changes.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../platform/helpers.js", async () => {
  const actual = await vi.importActual<typeof import("../platform/helpers.js")>(
    "../platform/helpers.js",
  );

  return {
    ...actual,
    currentPlatform: vi.fn(() => "darwin"),
    commandExists: vi.fn(() => false),
    runCommand: vi.fn(),
    runCommandBuffer: vi.fn(),
  };
});

import {
  classifyPermissionDeniedError,
  createPermissionDeniedError,
  isAccessibilityPermissionDenied,
  isPermissionDeniedError,
  isScreenRecordingPermissionDenied,
  permissionDeniedResultFromError,
} from "../platform/permissions.js";
import {
  runCommand,
  runCommandBuffer,
} from "../platform/helpers.js";
import { desktopClick } from "../platform/desktop.js";
import { captureScreenshot } from "../platform/screenshot.js";

function makeExecError(message: string): Error {
  const error = new Error(message) as Error & {
    stderr?: Buffer;
    stdout?: Buffer;
  };

  error.stderr = Buffer.from(message);
  error.stdout = Buffer.from("");
  return error;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("permission helper", () => {
  it("creates structured denial results", () => {
    const err = createPermissionDeniedError({
      permissionType: "accessibility",
      operation: "desktop_click",
      message: "Accessibility permission is required.",
      details: "not authorized to send apple events",
    });

    expect(isPermissionDeniedError(err)).toBe(true);
    expect(err.permissionDenied).toBe(true);
    expect(err.permissionType).toBe("accessibility");
    expect(err.operation).toBe("desktop_click");
    expect(err.toResult()).toMatchObject({
      success: false,
      permissionDenied: true,
      permissionType: "accessibility",
      operation: "desktop_click",
    });
  });

  it("detects accessibility denial messages on macOS", () => {
    const error = makeExecError("Not authorized to send Apple events to System Events");
    expect(isAccessibilityPermissionDenied(error)).toBe(true);
    expect(isScreenRecordingPermissionDenied(error)).toBe(false);
    expect(
      classifyPermissionDeniedError(error, {
        permissionType: "accessibility",
        operation: "desktop_type",
      }),
    ).toMatchObject({
      permissionDenied: true,
      permissionType: "accessibility",
      operation: "desktop_type",
    });
  });

  it("detects screen recording denial messages on macOS", () => {
    const error = makeExecError("screencapture failed because screen recording permission was denied");
    expect(isScreenRecordingPermissionDenied(error)).toBe(true);
    expect(isAccessibilityPermissionDenied(error)).toBe(false);
    const result = classifyPermissionDeniedError(error, {
      permissionType: "screen_recording",
      operation: "screenshot_capture",
    });
    expect(result).toMatchObject({
      permissionDenied: true,
      permissionType: "screen_recording",
      operation: "screenshot_capture",
    });
  });

  it("does not misclassify ordinary errors", () => {
    const error = makeExecError("temporary network failure");
    expect(isAccessibilityPermissionDenied(error)).toBe(false);
    expect(isScreenRecordingPermissionDenied(error)).toBe(false);
    expect(
      classifyPermissionDeniedError(error, {
        permissionType: "accessibility",
        operation: "desktop_click",
      }),
    ).toBeNull();
    expect(permissionDeniedResultFromError(error)).toBeNull();
  });
});

describe("permission translation in platform operations", () => {
  it("translates macOS accessibility failures into structured desktop errors", () => {
    vi.mocked(runCommand).mockImplementation(() => {
      throw makeExecError("Not authorized to send Apple events to System Events");
    });

    try {
      desktopClick(10, 10);
      throw new Error("Expected desktopClick to throw");
    } catch (error) {
      expect(error).toMatchObject({
        permissionDenied: true,
        permissionType: "accessibility",
        operation: "desktop_click",
      });
    }
  });

  it("translates macOS screen recording failures into structured screenshot errors", () => {
    vi.mocked(runCommandBuffer).mockImplementation(() => {
      throw makeExecError("screencapture failed because screen recording permission was denied");
    });

    try {
      captureScreenshot();
      throw new Error("Expected captureScreenshot to throw");
    } catch (error) {
      expect(error).toMatchObject({
        permissionDenied: true,
        permissionType: "screen_recording",
        operation: "screenshot_capture",
      });
    }
  });
});
