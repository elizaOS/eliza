/**
 * Tests for platform/permissions.ts — permission error classification.
 */
import { describe, expect, it } from "vitest";
import {
  classifyPermissionDeniedError,
  createPermissionDeniedError,
  isPermissionDeniedError,
} from "../platform/permissions.js";

describe("createPermissionDeniedError", () => {
  it("creates a PermissionDeniedError with correct properties", () => {
    const error = createPermissionDeniedError({
      permissionType: "screen_recording",
      operation: "screenshot",
      message: "Screen Recording permission required",
      details: "screencapture failed",
    });

    expect(error).toBeInstanceOf(Error);
    expect(error.permissionDenied).toBe(true);
    expect(error.permissionType).toBe("screen_recording");
    expect(error.operation).toBe("screenshot");
    expect(error.details).toBe("screencapture failed");
    expect(error.message).toBe("Screen Recording permission required");
  });
});

describe("isPermissionDeniedError", () => {
  it("identifies PermissionDeniedError", () => {
    const error = createPermissionDeniedError({
      permissionType: "accessibility",
      operation: "click",
      message: "Accessibility required",
    });
    expect(isPermissionDeniedError(error)).toBe(true);
  });

  it("rejects regular errors", () => {
    expect(isPermissionDeniedError(new Error("oops"))).toBe(false);
  });

  it("rejects non-errors", () => {
    expect(isPermissionDeniedError(null)).toBe(false);
    expect(isPermissionDeniedError("string")).toBe(false);
    expect(isPermissionDeniedError(42)).toBe(false);
  });
});

describe("classifyPermissionDeniedError", () => {
  it("classifies macOS screen recording errors", () => {
    const error = new Error("could not create image from display");
    const classified = classifyPermissionDeniedError(error, {
      permissionType: "screen_recording",
      operation: "screenshot",
    });
    expect(classified).not.toBeNull();
    expect(classified!.permissionType).toBe("screen_recording");
  });

  it("classifies macOS accessibility errors", () => {
    const error = new Error("osascript is not allowed assistive access");
    const classified = classifyPermissionDeniedError(error, {
      permissionType: "accessibility",
      operation: "click",
    });
    expect(classified).not.toBeNull();
    expect(classified!.permissionType).toBe("accessibility");
  });

  it("returns null for non-permission errors", () => {
    const error = new Error("file not found");
    const classified = classifyPermissionDeniedError(error, {
      permissionType: "screen_recording",
      operation: "screenshot",
    });
    expect(classified).toBeNull();
  });

  it("passes through existing PermissionDeniedErrors", () => {
    const original = createPermissionDeniedError({
      permissionType: "camera",
      operation: "capture",
      message: "Camera denied",
    });
    const classified = classifyPermissionDeniedError(original, {
      permissionType: "screen_recording",
      operation: "screenshot",
    });
    expect(classified).toBe(original);
    expect(classified!.permissionType).toBe("camera"); // preserves original
  });
});
