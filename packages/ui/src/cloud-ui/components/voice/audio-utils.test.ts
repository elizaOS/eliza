/**
 * Unit tests for audio utils: validates browser media recording capability helpers.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getSupportedMimeType,
  supportsGetUserMedia,
  supportsMediaRecorder,
} from "./audio-utils.ts";

describe("audio-utils", () => {
  const globalScope = globalThis as unknown as {
    MediaRecorder?: { isTypeSupported: (type: string) => boolean };
    window?: unknown;
  };
  const originalMediaRecorder = globalScope.MediaRecorder;
  const originalWindow = globalScope.window;
  const originalMediaDevices =
    typeof navigator !== "undefined" ? navigator.mediaDevices : undefined;

  beforeEach(() => {
    globalScope.MediaRecorder = {
      isTypeSupported: (type: string) => type.includes("webm"),
    };
  });

  afterEach(() => {
    if (originalMediaRecorder !== undefined) {
      globalScope.MediaRecorder = originalMediaRecorder;
    } else {
      delete globalScope.MediaRecorder;
    }

    if (originalWindow !== undefined) {
      globalScope.window = originalWindow;
    } else {
      delete globalScope.window;
    }

    if (typeof navigator !== "undefined") {
      if (originalMediaDevices !== undefined) {
        Object.defineProperty(navigator, "mediaDevices", {
          value: originalMediaDevices,
          configurable: true,
          writable: true,
        });
      } else {
        delete (navigator as Record<string, unknown>).mediaDevices;
      }
    }
  });

  it("detects MediaRecorder support when window.MediaRecorder is present or absent", () => {
    delete globalScope.window;
    expect(supportsMediaRecorder()).toBe(false);

    globalScope.window = { MediaRecorder: {} };
    expect(supportsMediaRecorder()).toBe(true);
  });

  it("detects getUserMedia support when navigator.mediaDevices is present or absent", () => {
    globalScope.window = {};
    Object.defineProperty(navigator, "mediaDevices", {
      value: { getUserMedia: vi.fn() },
      configurable: true,
      writable: true,
    });
    expect(supportsGetUserMedia()).toBe(true);

    delete (navigator as Record<string, unknown>).mediaDevices;
    expect(supportsGetUserMedia()).toBe(false);

    (navigator as Record<string, unknown>).mediaDevices = undefined;
    expect(supportsGetUserMedia()).toBe(false);
  });

  it("returns first supported mime type from MediaRecorder", () => {
    const mime = getSupportedMimeType();
    expect(mime).toContain("webm");
  });

  it("returns empty string when no mime type is supported", () => {
    globalScope.MediaRecorder = {
      isTypeSupported: () => false,
    };
    expect(getSupportedMimeType()).toBe("");
  });
});
