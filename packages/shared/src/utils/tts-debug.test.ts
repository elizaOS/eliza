/**
 * Server-side `ttsDebug` emission through the real structured logger: the
 * `ELIZA_TTS_DEBUG` flag gates output, and entries are observed via the
 * logger's global listener stream — no logger mocking.
 */
import {
  addLogListener,
  type LogEntry,
  toWellFormedUnicode,
} from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTtsDebugEnabled, ttsDebug, ttsDebugTextPreview } from "./tts-debug";

// The logger freezes its level at module init and the repo test setup defaults
// LOG_LEVEL to "error", which would gate the info-level tts lines (and their
// listener delivery) off before this suite could observe them. vi.hoisted runs
// before the imports above evaluate, so the logger initializes at "info" —
// the production default this diagnostic is documented against.
vi.hoisted(() => {
  process.env.LOG_LEVEL = "info";
});

const prevFlag = process.env.ELIZA_TTS_DEBUG;

function restoreFlag(): void {
  if (prevFlag === undefined) delete process.env.ELIZA_TTS_DEBUG;
  else process.env.ELIZA_TTS_DEBUG = prevFlag;
}

describe("ttsDebug (server flavor)", () => {
  let entries: LogEntry[] = [];
  let unsubscribe: (() => void) | null = null;

  const ttsEntries = () =>
    entries.filter((entry) => entry.msg.includes("[eliza][tts]"));

  beforeEach(() => {
    entries = [];
    unsubscribe = addLogListener((entry) => entries.push(entry));
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
    restoreFlag();
  });

  it("emits nothing when ELIZA_TTS_DEBUG is unset", () => {
    delete process.env.ELIZA_TTS_DEBUG;
    expect(isTtsDebugEnabled()).toBe(false);
    ttsDebug("server:cloud-tts:proxy", { textChars: 5 });
    expect(ttsEntries()).toHaveLength(0);
  });

  it("emits nothing for falsy flag values", () => {
    for (const value of ["0", "false", "off", "no", "", "  "]) {
      process.env.ELIZA_TTS_DEBUG = value;
      expect(isTtsDebugEnabled()).toBe(false);
      ttsDebug("server:cloud-tts:proxy");
    }
    expect(ttsEntries()).toHaveLength(0);
  });

  it("recognizes every documented truthy variant", () => {
    for (const value of ["1", "true", "yes", "on", " TRUE ", "On"]) {
      process.env.ELIZA_TTS_DEBUG = value;
      expect(isTtsDebugEnabled()).toBe(true);
    }
  });

  it("emits an info-level entry carrying phase and detail when enabled", () => {
    process.env.ELIZA_TTS_DEBUG = "1";
    ttsDebug("server:cloud-tts:proxy", {
      textChars: 11,
      preview: "hello world",
    });

    // The logger mirrors each line into the in-memory buffer from two spots
    // (direct write + adze listener), so assert on presence, not count.
    const hits = ttsEntries();
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]?.msg).toContain("[eliza][tts] server:cloud-tts:proxy");
    expect(hits[0]?.msg).toContain("hello world");
    expect(hits[0]?.msg).toContain("textChars");
    // 30 = info: the operator opted in, so lines must be visible at the
    // default LOG_LEVEL rather than hiding behind debug.
    expect(hits[0]?.level).toBe(30);
  });

  it("emits a phase-only entry when no detail is passed", () => {
    process.env.ELIZA_TTS_DEBUG = "true";
    ttsDebug("server:local-tts:request");

    const hits = ttsEntries();
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]?.msg.trim()).toBe("[eliza][tts] server:local-tts:request");
  });
});

describe("ttsDebugTextPreview", () => {
  it("collapses newlines and whitespace into one line", () => {
    expect(ttsDebugTextPreview("hello\nworld\r\n  again")).toBe(
      "hello↵ world↵ again",
    );
  });

  it("truncates long text with an ellipsis at the default cap", () => {
    const long = "a".repeat(200);
    const preview = ttsDebugTextPreview(long);
    expect(preview).toBe(`${"a".repeat(160)}…`);
  });

  it("honors a custom cap and leaves short text untouched", () => {
    expect(ttsDebugTextPreview("short text", 20)).toBe("short text");
    expect(ttsDebugTextPreview("abcdefghij", 4)).toBe("abcd…");
  });
});

describe("ttsDebugTextPreview surrogate safety (shared)", () => {
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
    expect(() => JSON.stringify(result)).not.toThrow();
    expect(result.length).toBeLessThanOrEqual(161);
  });

  it("preserves a fitting astral emoji at the cap (a*158+🦊 at 160)", () => {
    const input = `${"a".repeat(158)}🦊`;
    const result = ttsDebugTextPreview(input, 160);
    expect(isWellFormed(result)).toBe(true);
    expect(result).toBe(toWellFormedUnicode(`${"a".repeat(158)}🦊`));
  });

  it("sanitizes lone high surrogate to replacement character", () => {
    const input = `ok \ud800 end ${"x".repeat(200)}`;
    const result = ttsDebugTextPreview(input, 160);
    expect(isWellFormed(result)).toBe(true);
    expect(result.includes("�")).toBe(true);
  });

  it("sanitizes lone low surrogate to replacement character", () => {
    const input = `ok \udc00 end ${"x".repeat(200)}`;
    const result = ttsDebugTextPreview(input, 160);
    expect(isWellFormed(result)).toBe(true);
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
  });

  it("handles astral at 1-char cap without emitting a lone surrogate", () => {
    const input = `😀${"a".repeat(10)}`;
    const result = ttsDebugTextPreview(input, 1);
    expect(isWellFormed(result)).toBe(true);
    expect(result).toBe("…");
  });
});
