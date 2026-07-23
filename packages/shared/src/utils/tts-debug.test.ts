/**
 * Server-side `ttsDebug` emission through the real structured logger: the
 * `ELIZA_TTS_DEBUG` flag gates output, and entries are observed via the
 * logger's global listener stream — no logger mocking.
 */
import { addLogListener, type LogEntry } from "@elizaos/core";
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
