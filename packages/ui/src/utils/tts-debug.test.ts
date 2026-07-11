/**
 * Verifies TTS diagnostics stay readable as a single argument in mobile WebView
 * logcat without letting unusual diagnostic values break playback.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ttsDebug } from "./tts-debug";

describe("ttsDebug", () => {
  const originalDebug = process.env.ELIZA_TTS_DEBUG;
  let info: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    process.env.ELIZA_TTS_DEBUG = "1";
    info = vi.spyOn(console, "info").mockImplementation(() => undefined);
  });

  afterEach(() => {
    if (originalDebug === undefined) {
      delete process.env.ELIZA_TTS_DEBUG;
    } else {
      process.env.ELIZA_TTS_DEBUG = originalDebug;
    }
    vi.restoreAllMocks();
  });

  it("serializes detail into one WebView-safe log argument", () => {
    ttsDebug("play:start", { messageId: "msg-1", clipSegment: 2 });

    expect(info).toHaveBeenCalledWith(
      '[eliza][tts] play:start {"messageId":"msg-1","clipSegment":2}',
    );
  });

  it("safely serializes bigint and circular diagnostic values", () => {
    const detail: Record<string, unknown> = { elapsedNs: 12n };
    detail.self = detail;

    ttsDebug("play:end", detail);

    expect(info).toHaveBeenCalledWith(
      '[eliza][tts] play:end {"elapsedNs":"12","self":"[Circular]"}',
    );
  });

  it("keeps the no-detail log form", () => {
    ttsDebug("play:end");

    expect(info).toHaveBeenCalledWith("[eliza][tts] play:end");
  });

  it("does not let a throwing diagnostic getter interrupt playback", () => {
    const detail: Record<string, unknown> = {};
    Object.defineProperty(detail, "broken", {
      enumerable: true,
      get: () => {
        throw new Error("diagnostic getter failed");
      },
    });

    expect(() => ttsDebug("play:error", detail)).not.toThrow();
    expect(info).toHaveBeenCalledWith(
      "[eliza][tts] play:error [Unserializable diagnostic detail]",
    );
  });
});
