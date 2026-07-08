// Unit tests for the auto-send reliability guard (voice auto-send lane).
// Pure logic — the bar an end-of-speech transcript must clear before it is
// auto-sent hands-free (empty / single-token / too-short suppression).

import { describe, expect, it } from "vitest";
import { passesAutoSendGuard } from "./auto-send-guard";
import { AUTO_SEND_GUARD } from "./vad-params";

describe("passesAutoSendGuard — passes", () => {
  it("accepts a normal multi-word transcript", () => {
    const r = passesAutoSendGuard({ transcript: "turn on the kitchen light" });
    expect(r.ok).toBe(true);
    expect(r.reason).toBeUndefined();
    expect(r.wordCount).toBe(5);
  });

  it("accepts a two-word transcript at the minWords floor", () => {
    const r = passesAutoSendGuard({ transcript: "hello there" });
    expect(r.ok).toBe(true);
  });

  it("accepts when speechMs is comfortably above the floor", () => {
    const r = passesAutoSendGuard({
      transcript: "what time is it",
      speechMs: 1200,
    });
    expect(r.ok).toBe(true);
  });
});

describe("passesAutoSendGuard — suppresses (the reliability bar)", () => {
  it("rejects an empty transcript", () => {
    const r = passesAutoSendGuard({ transcript: "" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("empty");
  });

  it("rejects a whitespace-only transcript", () => {
    const r = passesAutoSendGuard({ transcript: "   \n\t " });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("empty");
  });

  it("rejects a sub-minChars transcript", () => {
    // A single char is below minChars (2) — treated as too-short before the
    // word check (a lone "a").
    const r = passesAutoSendGuard({ transcript: "a" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("too-short-chars");
  });

  it("rejects a single-token transcript (the classic misfire)", () => {
    const r = passesAutoSendGuard({ transcript: "okay" });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("single-token");
    expect(r.wordCount).toBe(1);
  });

  it("rejects a too-short-speech blip even with enough words", () => {
    const r = passesAutoSendGuard({
      transcript: "yes go",
      speechMs: 120, // below the 350ms floor
    });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("too-short-speech");
  });

  it("skips the speech-duration check when speechMs is absent", () => {
    // Transcript-only backends (no measured duration) still pass on char/word.
    const r = passesAutoSendGuard({ transcript: "send it now" });
    expect(r.ok).toBe(true);
  });

  it("skips the speech-duration check when speechMs is not finite", () => {
    const r = passesAutoSendGuard({
      transcript: "send it now",
      speechMs: Number.NaN,
    });
    expect(r.ok).toBe(true);
  });
});

describe("passesAutoSendGuard — params come from the single VAD-params source", () => {
  it("uses AUTO_SEND_GUARD by default", () => {
    // A transcript exactly at the char floor with two words passes; one below
    // fails — proving the default params are the AUTO_SEND_GUARD constants.
    expect(AUTO_SEND_GUARD.minWords).toBe(2);
    expect(passesAutoSendGuard({ transcript: "a" }).ok).toBe(false);
    expect(passesAutoSendGuard({ transcript: "go now" }).ok).toBe(true);
  });

  it("honors an injected params override", () => {
    // Loosen to allow single tokens — proves the guard reads the passed params,
    // not a hardcoded copy.
    const loose = { minChars: 1, minWords: 1, minSpeechMs: 0 };
    expect(passesAutoSendGuard({ transcript: "yes" }, loose).ok).toBe(true);
  });

  it("never throws on a malformed input", () => {
    // @ts-expect-error deliberately passing a non-string to prove robustness
    const r = passesAutoSendGuard({ transcript: undefined });
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("empty");
  });
});
