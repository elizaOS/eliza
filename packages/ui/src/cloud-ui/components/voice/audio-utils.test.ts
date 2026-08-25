/**
 * Unit tests for the callable browser capabilities required by voice recording.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getSupportedMimeType,
  supportsGetUserMedia,
  supportsMediaRecorder,
} from "./audio-utils.ts";

const SupportedMediaRecorder = Object.assign(
  function SupportedMediaRecorder() {},
  {
    isTypeSupported: (type: string): boolean => type.includes("webm"),
  },
);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("supportsMediaRecorder", () => {
  it("rejects absent and partial MediaRecorder implementations", () => {
    vi.stubGlobal("window", {});
    expect(supportsMediaRecorder()).toBe(false);

    vi.stubGlobal("window", { MediaRecorder: undefined });
    expect(supportsMediaRecorder()).toBe(false);

    vi.stubGlobal("window", { MediaRecorder: {} });
    expect(supportsMediaRecorder()).toBe(false);

    vi.stubGlobal("window", { MediaRecorder: class MediaRecorder {} });
    expect(supportsMediaRecorder()).toBe(false);
  });

  it("accepts a callable recorder with MIME capability detection", () => {
    vi.stubGlobal("window", { MediaRecorder: SupportedMediaRecorder });
    expect(supportsMediaRecorder()).toBe(true);
  });
});

describe("supportsGetUserMedia", () => {
  it("rejects absent and non-callable getUserMedia implementations", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {});
    expect(supportsGetUserMedia()).toBe(false);

    vi.stubGlobal("navigator", { mediaDevices: {} });
    expect(supportsGetUserMedia()).toBe(false);

    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: true } });
    expect(supportsGetUserMedia()).toBe(false);
  });

  it("accepts a callable getUserMedia implementation", () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {
      mediaDevices: { getUserMedia: vi.fn() },
    });
    expect(supportsGetUserMedia()).toBe(true);
  });
});

describe("getSupportedMimeType", () => {
  it("returns the first supported MIME type", () => {
    vi.stubGlobal("MediaRecorder", SupportedMediaRecorder);
    expect(getSupportedMimeType()).toBe("audio/webm;codecs=opus");
  });

  it("returns an empty string when capability detection is unavailable", () => {
    vi.stubGlobal("MediaRecorder", class MediaRecorder {});
    expect(getSupportedMimeType()).toBe("");
  });

  it("returns an empty string when no MIME type is supported", () => {
    const UnsupportedMediaRecorder = Object.assign(
      function UnsupportedMediaRecorder() {},
      { isTypeSupported: (): boolean => false },
    );

    vi.stubGlobal("MediaRecorder", UnsupportedMediaRecorder);
    expect(getSupportedMimeType()).toBe("");
  });
});
