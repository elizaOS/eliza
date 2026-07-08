// Unit test for the VAD debug logger (voice VAD-tunability lane, on top of V2a
// #15417). Verifies the owner ask — a *cheap-when-off* QA affordance: a genuine
// no-op (no console call, no allocation past the flag check) when
// `ELIZA_VOICE_VAD_DEBUG` is unset, and a single `[eliza][vad] <event>` line
// carrying the structured decision detail when the flag is on. Ported+adapted
// from #15417's vad-debug.test.ts to this branch's single-object API
// (`vadDebug(detail)` / `console.info` / `ELIZA_VOICE_VAD_DEBUG`, no cache).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { isVadDebugEnabled, vadDebug } from "./vad-debug";

const FLAG = "ELIZA_VOICE_VAD_DEBUG";

describe("vadDebug", () => {
  const prev = process.env[FLAG];

  beforeEach(() => {
    delete process.env[FLAG];
  });

  afterEach(() => {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
    vi.restoreAllMocks();
  });

  it("is a no-op when ELIZA_VOICE_VAD_DEBUG is unset", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    expect(isVadDebugEnabled()).toBe(false);
    vadDebug({ event: "auto-stop", trigger: "maxSpeechMs" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("stays a no-op for non-truthy flag values", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    for (const val of ["0", "false", "no", "off", ""]) {
      process.env[FLAG] = val;
      expect(isVadDebugEnabled()).toBe(false);
      vadDebug({ event: "speech-end", silenceMs: 400 });
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it("enables on the documented truthy values", () => {
    for (const val of ["1", "true", "yes", "on", "TRUE", "  On  "]) {
      process.env[FLAG] = val;
      expect(isVadDebugEnabled()).toBe(true);
    }
  });

  it("logs one [eliza][vad] line with the structured detail when enabled", () => {
    process.env[FLAG] = "1";
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});
    expect(isVadDebugEnabled()).toBe(true);

    const detail = {
      event: "speech-end" as const,
      atMs: 1234,
      speechMs: 900,
      silenceMs: 420,
      trigger: "silenceMs",
      echoGated: false,
    };
    vadDebug(detail);

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe("[eliza][vad] speech-end");
    expect(spy.mock.calls[0]?.[1]).toEqual(detail);
  });

  it("surfaces the auto-send guard outcome (the suppressed-turn QA case)", () => {
    process.env[FLAG] = "1";
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});

    vadDebug({
      event: "auto-send",
      guardOk: false,
      guardReason: "single-token",
      transcriptPreview: "the",
    });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]?.[0]).toBe("[eliza][vad] auto-send");
    expect(spy.mock.calls[0]?.[1]).toMatchObject({
      event: "auto-send",
      guardOk: false,
      guardReason: "single-token",
    });
  });

  it("re-reads the env each call (no cached enable flag)", () => {
    const spy = vi.spyOn(console, "info").mockImplementation(() => {});

    // Off first — no log.
    vadDebug({ event: "speech-start", atMs: 1 });
    expect(spy).not.toHaveBeenCalled();

    // Flip on within the same test: the very next call must log without any
    // cache-reset helper (this branch reads process.env live).
    process.env[FLAG] = "1";
    vadDebug({ event: "speech-start", atMs: 2 });
    expect(spy).toHaveBeenCalledTimes(1);

    // Flip back off: silent again.
    delete process.env[FLAG];
    vadDebug({ event: "speech-start", atMs: 3 });
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
