// Unit tests for the auto-send reliability guards (voice V2a extension).
// Pure logic — the "don't auto-send accidental noise" gate the owner flagged as
// the reliability requirement for flipping the auto-send default later.

import { describe, expect, it } from "vitest";
import {
  DEFAULT_VOICE_AUTOSEND,
  evaluateAutoSend,
} from "./voice-autosend-config";

describe("evaluateAutoSend", () => {
  const cfg = DEFAULT_VOICE_AUTOSEND;

  it("sends a normal multi-word utterance", () => {
    expect(evaluateAutoSend("turn on the kitchen light", cfg, 1200)).toEqual({
      send: true,
      reason: "ok",
    });
  });

  it("rejects an empty transcript", () => {
    expect(evaluateAutoSend("   ", cfg, 1000).send).toBe(false);
    expect(evaluateAutoSend("", cfg, 1000).reason).toBe("empty");
  });

  it("rejects a too-short transcript (below min chars)", () => {
    const d = evaluateAutoSend("ok", { ...cfg, minTranscriptChars: 5 }, 1000);
    expect(d).toEqual({ send: false, reason: "too-few-chars" });
  });

  it("rejects a single-word utterance (accidental 'hey')", () => {
    const d = evaluateAutoSend("hey", cfg, 1000);
    expect(d).toEqual({ send: false, reason: "too-few-words" });
  });

  it("rejects a blip shorter than the min speech duration", () => {
    // Two words, clears char/word gates, but only 100ms of speech → noise.
    const d = evaluateAutoSend("uh huh", cfg, 100);
    expect(d).toEqual({ send: false, reason: "too-short-speech" });
  });

  it("skips the duration gate when speechDurationMs is unknown", () => {
    // Transcript-only backends may not surface duration; char/word gates still
    // apply, and a valid multi-word utterance still sends.
    expect(evaluateAutoSend("hello there", cfg).send).toBe(true);
  });

  it("has conservative defaults (safe to ship off, flip later)", () => {
    expect(DEFAULT_VOICE_AUTOSEND.minTranscriptWords).toBeGreaterThanOrEqual(2);
    expect(DEFAULT_VOICE_AUTOSEND.minSpeechMs).toBeGreaterThan(0);
    expect(DEFAULT_VOICE_AUTOSEND.minTranscriptChars).toBeGreaterThan(0);
  });
});
