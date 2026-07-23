/**
 * Pins the #16958 guarantee: `ttsDebug` must emit through the real structured
 * logger even when `LOG_LEVEL` sits above `info` (warn/error), because the
 * operator explicitly opted in via `ELIZA_TTS_DEBUG`. The logger freezes its
 * level at module init, so this suite pins LOG_LEVEL=error before the logger
 * loads (vi.hoisted) and observes emission via the logger's global listener
 * stream — no logger mocking. The listener only fires for entries that passed
 * the level gate, so a delivered entry IS proof of emission.
 */
import { addLogListener, type LogEntry } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ttsDebug } from "./tts-debug";

// vi.hoisted runs before the imports above evaluate, so the logger initializes
// with the strictest common operator configuration this defect hid under.
vi.hoisted(() => {
  process.env.LOG_LEVEL = "error";
});

const prevFlag = process.env.ELIZA_TTS_DEBUG;

describe("ttsDebug under LOG_LEVEL=error (#16958)", () => {
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
    if (prevFlag === undefined) delete process.env.ELIZA_TTS_DEBUG;
    else process.env.ELIZA_TTS_DEBUG = prevFlag;
  });

  it("still emits when the operator explicitly set ELIZA_TTS_DEBUG=1", () => {
    process.env.ELIZA_TTS_DEBUG = "1";
    ttsDebug("server:cloud-tts:proxy", {
      textChars: 11,
      preview: "hello world",
    });

    const hits = ttsEntries();
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]?.msg).toContain("[eliza][tts] server:cloud-tts:proxy");
    expect(hits[0]?.msg).toContain("hello world");
    // 50 = error: the diagnostic escalates to the active threshold so the
    // opt-in is never silently dead; at the default LOG_LEVEL it stays info
    // (covered by tts-debug.test.ts).
    expect(hits[0]?.level).toBe(50);
  });

  it("emits phase-only lines too, not just detailed ones", () => {
    process.env.ELIZA_TTS_DEBUG = "true";
    ttsDebug("server:local-tts:request");

    const hits = ttsEntries();
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]?.msg.trim()).toBe("[eliza][tts] server:local-tts:request");
  });

  it("stays silent when the flag is unset, regardless of LOG_LEVEL", () => {
    delete process.env.ELIZA_TTS_DEBUG;
    ttsDebug("server:cloud-tts:proxy", { textChars: 5 });
    expect(ttsEntries()).toHaveLength(0);
  });
});
