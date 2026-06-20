import { describe, expect, it } from "vitest";
import {
  isTranscriptionExitPhrase,
  stripExitPhrase,
} from "./transcription-exit";

describe("isTranscriptionExitPhrase", () => {
  it("matches explicit exit phrases (case/punctuation-insensitive)", () => {
    for (const p of [
      "exit transcription mode",
      "Exit Transcription Mode.",
      "please stop transcription",
      "end transcription",
      "ok, stop transcribing now",
      "exit transcription, thanks",
    ]) {
      expect(isTranscriptionExitPhrase(p)).toBe(true);
    }
  });

  it("matches a short standalone keyword utterance", () => {
    expect(isTranscriptionExitPhrase("stop")).toBe(true);
    expect(isTranscriptionExitPhrase("exit")).toBe(true);
    expect(isTranscriptionExitPhrase("okay stop")).toBe(true);
    expect(isTranscriptionExitPhrase("transcription off")).toBe(true);
  });

  it("does NOT match a long sentence that merely contains a keyword", () => {
    expect(
      isTranscriptionExitPhrase(
        "I waited at the bus stop for ages this morning",
      ),
    ).toBe(false);
    expect(
      isTranscriptionExitPhrase("we should exit through the north door later"),
    ).toBe(false);
  });

  it("is false for empty / normal long-form content", () => {
    expect(isTranscriptionExitPhrase("")).toBe(false);
    expect(isTranscriptionExitPhrase(null)).toBe(false);
    expect(
      isTranscriptionExitPhrase(
        "so today I want to talk about the quarterly plan",
      ),
    ).toBe(false);
  });
});

describe("stripExitPhrase", () => {
  it("returns the text preceding an explicit exit phrase", () => {
    expect(
      stripExitPhrase("and that's the last point. exit transcription mode"),
    ).toBe("and that's the last point.");
    expect(stripExitPhrase("wrap up here stop transcription")).toBe(
      "wrap up here",
    );
  });

  it("returns empty for a bare standalone exit utterance", () => {
    expect(stripExitPhrase("stop")).toBe("");
    expect(stripExitPhrase("okay stop")).toBe("");
  });

  it("returns the original text when no exit is present", () => {
    expect(stripExitPhrase("  normal dictated sentence  ")).toBe(
      "normal dictated sentence",
    );
  });
});
