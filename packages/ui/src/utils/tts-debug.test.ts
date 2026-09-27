/**
 * TTS debug serialization: opt-in `[eliza][tts]` lines must not interrupt
 * playback, and a value shared by two debug keys must be printed both times
 * rather than collapsed to "[Circular]" (#31004).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ttsDebug } from "./tts-debug.js";

describe("ttsDebug", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("preserves a shared non-cyclic reference instead of marking it [Circular]", () => {
    vi.stubEnv("ELIZA_TTS_DEBUG", "1");
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const shared = { id: 1 };
    ttsDebug("phase", { a: shared, b: shared });
    expect(info).toHaveBeenCalledTimes(1);
    const line = String(info.mock.calls[0]?.[0]);
    expect(line).toContain('"a":{"id":1}');
    expect(line).toContain('"b":{"id":1}');
    expect(line).not.toContain("[Circular]");
  });
});
