/**
 * Covers the audio helpers: upload validation, MediaRecorder capability probes,
 * MIME negotiation, and container normalization.
 *
 * `validateAudioFile` is the gate an upload passes through, so its limits must
 * mean what the caller said. A caller that passes `maxSize: 0` is disabling
 * uploads; resolving that through `||` would silently restore the 25MB default
 * and admit everything under it.
 *
 * Browser-dependent probes install minimal globals and remove them afterwards.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  ensureAudioFormat,
  getSupportedMimeType,
  supportsGetUserMedia,
  supportsMediaRecorder,
  validateAudioFile,
} from "./audio";

const g = globalThis as Record<string, unknown>;

const file = (size: number, type: string): File => ({ size, type, name: "clip" }) as File;

afterEach(() => {
  for (const key of ["window", "navigator", "MediaRecorder"]) delete g[key];
});

describe("validateAudioFile", () => {
  test("accepts a supported type inside the default size limit", () => {
    expect(validateAudioFile(file(1024, "audio/wav"))).toEqual({ valid: true });
  });

  test("accepts every documented default type", () => {
    for (const type of [
      "audio/mp3",
      "audio/mpeg",
      "audio/mp4",
      "audio/m4a",
      "audio/wav",
      "audio/webm",
      "audio/ogg",
    ]) {
      expect(validateAudioFile(file(10, type)).valid).toBe(true);
    }
  });

  test("rejects an unsupported type and names it", () => {
    const result = validateAudioFile(file(10, "video/mp4"));
    expect(result.valid).toBe(false);
    expect(result.error).toContain("video/mp4");
  });

  test("rejects a file over the default limit", () => {
    const result = validateAudioFile(file(25 * 1024 * 1024 + 1, "audio/wav"));
    expect(result.valid).toBe(false);
    expect(result.error).toContain("25MB");
  });

  test("treats a file exactly at the limit as acceptable", () => {
    expect(validateAudioFile(file(25 * 1024 * 1024, "audio/wav")).valid).toBe(true);
  });

  test("honours a custom size limit", () => {
    expect(validateAudioFile(file(2048, "audio/wav"), { maxSize: 1024 }).valid).toBe(false);
    expect(validateAudioFile(file(512, "audio/wav"), { maxSize: 1024 }).valid).toBe(true);
  });

  test("honours a caller that disables uploads with maxSize 0", () => {
    // 0 is a real limit meaning "reject everything", not an absent option.
    const result = validateAudioFile(file(1, "audio/wav"), { maxSize: 0 });
    expect(result.valid).toBe(false);
  });

  test("honours a custom allowlist", () => {
    expect(validateAudioFile(file(10, "audio/wav"), { allowedTypes: ["audio/ogg"] }).valid).toBe(
      false,
    );
    expect(validateAudioFile(file(10, "audio/ogg"), { allowedTypes: ["audio/ogg"] }).valid).toBe(
      true,
    );
  });

  test("an empty allowlist rejects every type", () => {
    expect(validateAudioFile(file(10, "audio/wav"), { allowedTypes: [] }).valid).toBe(false);
  });

  test("checks size before type, so an oversized bad type reports size", () => {
    const result = validateAudioFile(file(99 * 1024 * 1024, "video/mp4"));
    expect(result.error).toContain("too large");
  });
});

describe("capability probes", () => {
  test("report false with no browser globals", () => {
    expect(supportsMediaRecorder()).toBe(false);
    expect(supportsGetUserMedia()).toBe(false);
  });

  test("detect MediaRecorder when present", () => {
    g.window = { MediaRecorder: class {} };
    expect(supportsMediaRecorder()).toBe(true);
  });

  test("detect getUserMedia only when the method exists", () => {
    g.window = {};
    g.navigator = { mediaDevices: {} };
    expect(supportsGetUserMedia()).toBe(false);
    g.navigator = { mediaDevices: { getUserMedia: () => {} } };
    expect(supportsGetUserMedia()).toBe(true);
  });
});

describe("getSupportedMimeType", () => {
  test("prefers opus-in-webm when everything is supported", () => {
    g.MediaRecorder = { isTypeSupported: () => true };
    expect(getSupportedMimeType()).toBe("audio/webm;codecs=opus");
  });

  test("falls through the priority list in order", () => {
    g.MediaRecorder = {
      isTypeSupported: (type: string) => type === "audio/mp4" || type === "audio/wav",
    };
    expect(getSupportedMimeType()).toBe("audio/mp4");
  });

  test("returns an empty string when nothing is supported", () => {
    g.MediaRecorder = { isTypeSupported: () => false };
    expect(getSupportedMimeType()).toBe("");
  });

  test("never offers a video container", () => {
    g.MediaRecorder = { isTypeSupported: () => true };
    expect(getSupportedMimeType().startsWith("video/")).toBe(false);
  });
});

describe("ensureAudioFormat", () => {
  test("passes an audio blob through unchanged", async () => {
    const blob = new Blob(["x"], { type: "audio/webm" });
    expect(await ensureAudioFormat(blob)).toBe(blob);
  });

  test("rewrites a video/webm container to audio/webm", async () => {
    const rewritten = await ensureAudioFormat(new Blob(["x"], { type: "video/webm" }));
    expect(rewritten.type).toBe("audio/webm");
  });

  test("preserves the payload while rewriting the container", async () => {
    const rewritten = await ensureAudioFormat(new Blob(["payload"], { type: "video/webm" }));
    expect(await rewritten.text()).toBe("payload");
  });

  test("leaves an unrelated type alone", async () => {
    const blob = new Blob(["x"], { type: "application/octet-stream" });
    expect(await ensureAudioFormat(blob)).toBe(blob);
  });
});
