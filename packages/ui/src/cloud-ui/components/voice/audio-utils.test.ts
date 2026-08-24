/**
 * Unit tests for audio utils: validates browser media recording capability helpers.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getSupportedMimeType,
  supportsGetUserMedia,
  supportsMediaRecorder,
} from "./audio-utils.ts";

describe("audio-utils", () => {
  const globalScope = globalThis as unknown as {
    MediaRecorder?: { isTypeSupported: (type: string) => boolean };
  };
  const originalMediaRecorder = globalScope.MediaRecorder;

  beforeEach(() => {
    globalScope.MediaRecorder = {
      isTypeSupported: (type: string) => type.includes("webm"),
    };
  });

  afterEach(() => {
    if (originalMediaRecorder) {
      globalScope.MediaRecorder = originalMediaRecorder;
    } else {
      delete globalScope.MediaRecorder;
    }
  });

  it("returns boolean for media recorder capability", () => {
    expect(typeof supportsMediaRecorder()).toBe("boolean");
  });

  it("returns boolean for getUserMedia capability", () => {
    expect(typeof supportsGetUserMedia()).toBe("boolean");
  });

  it("returns first supported mime type from MediaRecorder", () => {
    const mime = getSupportedMimeType();
    expect(mime).toContain("webm");
  });
});
