/**
 * Verifies TTS diagnostics stay readable as a single argument in mobile WebView
 * logcat without letting unusual diagnostic values break playback.
 */

import { toWellFormedUnicode } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ttsDebug, ttsDebugTextPreview } from "./tts-debug";

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

describe("ttsDebugTextPreview surrogate safety", () => {
  const isWellFormed = (s: string): boolean => {
    const w = s as unknown as { isWellFormed?: () => boolean };
    if (typeof w.isWellFormed === "function") return w.isWellFormed();
    return toWellFormedUnicode(s) === s;
  };

  it("backs off when cut would split a surrogate pair (a*159+🦊 at 160)", () => {
    const input = `${"a".repeat(159)}🦊${"b".repeat(20)}`;
    const result = ttsDebugTextPreview(input, 160);
    expect(isWellFormed(result)).toBe(true);
    expect(result.endsWith("…")).toBe(true);
    expect(result.includes("\ud83e") || result.includes("\ud83d")).toBe(false);
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(result.length).toBeLessThanOrEqual(161);
  });

  it("preserves a fitting astral emoji at the cap (a*158+🦊 at 160)", () => {
    const input = `${"a".repeat(158)}🦊`;
    const result = ttsDebugTextPreview(input, 160);
    expect(isWellFormed(result)).toBe(true);
    expect(result).toBe(toWellFormedUnicode(`${"a".repeat(158)}🦊`));
  });

  it("sanitizes lone high surrogate \ud800 to replacement character", () => {
    const input = `ok \ud800 end ${"x".repeat(200)}`;
    const result = ttsDebugTextPreview(input, 160);
    expect(isWellFormed(result)).toBe(true);
    expect(result.includes("\ud800")).toBe(false);
    expect(result.includes("�")).toBe(true);
  });

  it("sanitizes lone low surrogate \udc00 to replacement character", () => {
    const input = `ok \udc00 end ${"x".repeat(200)}`;
    const result = ttsDebugTextPreview(input, 160);
    expect(isWellFormed(result)).toBe(true);
    expect(result.includes("\udc00")).toBe(false);
    expect(result.includes("�")).toBe(true);
  });

  it("stays well-formed across every emoji offset in a sweep (0..65 at cap 60)", () => {
    for (let offset = 0; offset <= 65; offset++) {
      const input = `${"a".repeat(offset)}🦊${"b".repeat(100)}`;
      const result = ttsDebugTextPreview(input, 60);
      expect(isWellFormed(result)).toBe(true);
      expect(result.length).toBeLessThanOrEqual(61);
      expect(() => JSON.stringify(result)).not.toThrow();
    }
  });

  it("returns well-formed text when under cap with lone surrogate", () => {
    const input = "ok \ud800 end";
    const result = ttsDebugTextPreview(input, 100);
    expect(isWellFormed(result)).toBe(true);
    expect(result.includes("�")).toBe(true);
    expect(result.includes("\ud800")).toBe(false);
  });

  it("handles astral at 1-char cap without emitting a lone surrogate", () => {
    const input = `😀${"a".repeat(10)}`;
    const result = ttsDebugTextPreview(input, 1);
    expect(isWellFormed(result)).toBe(true);
    expect(result).toBe("…");
  });
});
