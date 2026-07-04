/**
 * Tests the word-error-rate metric (normalizeWerText, wordErrorRate): text
 * normalization and Levenshtein-based scoring, plus that the voice self-test
 * quality gate (0.34) genuinely discriminates good from degraded ASR rather than
 * rubber-stamping a verbatim mock transcript. Pure functions, no mocks.
 */
import { describe, expect, it } from "vitest";

import { normalizeWerText, wordErrorRate } from "./voice-wer";

// voice-wer is the single source of truth for word-error-rate (#8785) — both the
// headless metric library and the headful self-test re-export it. It had no
// dedicated test; this pins the normalization + the Levenshtein scoring so the
// two consumers can never drift again.
describe("normalizeWerText", () => {
  it("lowercases and collapses whitespace", () => {
    expect(normalizeWerText("  Hello   WORLD ")).toBe("hello world");
  });

  it("strips punctuation but keeps letters, numbers, and apostrophes", () => {
    expect(normalizeWerText("It's 42, really?!")).toBe("it's 42 really");
  });

  it("retains unicode letters/numbers", () => {
    expect(normalizeWerText("Café déjà 3")).toBe("café déjà 3");
  });

  it("turns a punctuation-only string into empty", () => {
    expect(normalizeWerText("?!.,")).toBe("");
  });
});

describe("wordErrorRate", () => {
  it("is 0 for identical strings", () => {
    expect(wordErrorRate("the quick brown fox", "the quick brown fox")).toBe(0);
  });

  it("is case- and punctuation-insensitive (still 0)", () => {
    expect(wordErrorRate("The quick brown fox.", "the QUICK brown, fox")).toBe(
      0,
    );
  });

  it("scores a single substitution as 1/N", () => {
    // 3-word reference, one word wrong → 1/3
    expect(wordErrorRate("one two three", "one four three")).toBeCloseTo(
      1 / 3,
      10,
    );
  });

  it("scores a single insertion as 1/N", () => {
    expect(wordErrorRate("one two three", "one two extra three")).toBeCloseTo(
      1 / 3,
      10,
    );
  });

  it("scores a single deletion as 1/N", () => {
    expect(wordErrorRate("one two three", "one three")).toBeCloseTo(1 / 3, 10);
  });

  it("an empty reference scores 0 against an empty hypothesis", () => {
    expect(wordErrorRate("", "")).toBe(0);
    expect(wordErrorRate("   ", "?!.")).toBe(0);
  });

  it("an empty reference scores 1 against a non-empty hypothesis", () => {
    expect(wordErrorRate("", "anything here")).toBe(1);
  });

  it("can exceed 1 when the hypothesis is much longer (insertions dominate)", () => {
    // ref 1 word; hyp 3 words → 1 sub-or-match + 2 insertions = 2 errors / 1 = 2
    expect(wordErrorRate("hi", "hi there friend")).toBe(2);
  });

  it("scores a fully wrong same-length hypothesis as 1", () => {
    expect(wordErrorRate("alpha beta", "gamma delta")).toBe(1);
  });
});

// De-larp guard (#10726). The voice self-test's WER quality gate accepts a
// transcript only when `wer <= werTolerance` (default 0.34 in
// voice-selftest-harness.ts). The mocked-ASR self-test lane always feeds the
// EXPECTED phrase back verbatim, so its measured WER is always 0.0 — a
// tautology that proves the gate ACCEPTS a perfect transcript but never that it
// REJECTS a bad one. These cases pin that the metric genuinely discriminates
// ASR quality across the 0.34 boundary, so a real (degraded) transcript would
// fail the gate rather than sail through.
describe("WER discriminates real vs degraded ASR (self-test gate = 0.34)", () => {
  const GATE = 0.34; // voice-selftest-harness.ts default `werTolerance`
  const REFERENCE = "the quick brown fox jumps over the lazy dog"; // 9 words
  const passesGate = (hyp: string) => wordErrorRate(REFERENCE, hyp) <= GATE;

  it("a perfect transcript passes the gate (WER 0)", () => {
    expect(wordErrorRate(REFERENCE, REFERENCE)).toBe(0);
    expect(passesGate(REFERENCE)).toBe(true);
  });

  it("a near-perfect transcript (1 slip in 9) passes the gate", () => {
    // realistic single-word ASR slip → 1/9 ≈ 0.111, well under 0.34
    const hyp = "the quick brown fox jumped over the lazy dog";
    expect(wordErrorRate(REFERENCE, hyp)).toBeLessThan(GATE);
    expect(passesGate(hyp)).toBe(true);
  });

  it("a heavily degraded transcript FAILS the gate (WER > 0.34)", () => {
    // ~half the words wrong — the kind of output a broken/unloaded ASR model
    // produces. The gate MUST reject it.
    const hyp = "the quiet brown box bumps under a hazy dog";
    expect(wordErrorRate(REFERENCE, hyp)).toBeGreaterThan(GATE);
    expect(passesGate(hyp)).toBe(false);
  });

  it("garbage / hallucinated output FAILS the gate", () => {
    const hyp = "please connect a provider to continue";
    expect(wordErrorRate(REFERENCE, hyp)).toBeGreaterThan(GATE);
    expect(passesGate(hyp)).toBe(false);
  });

  it("an empty transcript (silent / dropped capture) FAILS the gate", () => {
    expect(wordErrorRate(REFERENCE, "")).toBe(1);
    expect(passesGate("")).toBe(false);
  });
});
