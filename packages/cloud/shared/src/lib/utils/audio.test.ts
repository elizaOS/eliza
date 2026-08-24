/**
 * Coverage for audio.
 */
import { describe, expect, it } from "vitest";
import { supportsGetUserMedia, supportsMediaRecorder, validateAudioFile } from "./audio.js";

describe("audio", () => {
  it("validates audio file", () => {
    const file = new File(["hello"], "test.mp3", { type: "audio/mpeg" });
    const r = validateAudioFile(file);
    expect(r.valid).toBe(true);
    const bad = new File(["x".repeat(30 * 1024 * 1024)], "big.mp3", { type: "audio/mpeg" });
    const r2 = validateAudioFile(bad, { maxSize: 1024 });
    expect(r2.valid).toBe(false);
    expect(r2.error).toBeTruthy();
  });
  it("checks media recorder support", () => {
    expect(typeof supportsMediaRecorder()).toBe("boolean");
    expect(typeof supportsGetUserMedia()).toBe("boolean");
  });
});
