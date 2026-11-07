/**
 * `stripExitPhrase` must agree with `isTranscriptionExitPhrase` on what counts
 * as an explicit exit phrase. Detection is punctuation-insensitive (it runs on
 * normalized text), but stripping used a literal substring search — so when
 * punctuation fell inside a phrase ("stop, transcription"), the phrase was
 * detected yet the preceding dictated content was silently dropped instead of
 * being returned as the final turn.
 */
import { describe, expect, it } from "vitest";
import {
  isTranscriptionExitPhrase,
  stripExitPhrase,
} from "../transcription-exit";

describe("stripExitPhrase", () => {
  it("returns content before a plain explicit phrase", () => {
    expect(isTranscriptionExitPhrase("Hello world stop transcription")).toBe(
      true,
    );
    expect(stripExitPhrase("Hello world stop transcription")).toBe(
      "Hello world",
    );
  });

  it("preserves content before a phrase split by a comma", () => {
    const text = "Note this down: stop, transcription";
    expect(isTranscriptionExitPhrase(text)).toBe(true);
    expect(stripExitPhrase(text)).toBe("Note this down:");
  });

  it("preserves content before a phrase split by a period", () => {
    const text = "Please stop. transcription now";
    expect(isTranscriptionExitPhrase(text)).toBe(true);
    expect(stripExitPhrase(text)).toBe("Please");
  });

  it("cuts at the earliest phrase occurrence", () => {
    expect(stripExitPhrase("First stop transcription, then exit transcription")).toBe(
      "First",
    );
  });

  it("keeps original casing and punctuation in the preserved prefix", () => {
    expect(stripExitPhrase("PLEASE, Stop Transcription!")).toBe("PLEASE,");
  });

  it("returns empty string for a bare standalone-keyword utterance", () => {
    const text = "stop";
    expect(isTranscriptionExitPhrase(text)).toBe(true);
    expect(stripExitPhrase(text)).toBe("");
  });

  it("returns the trimmed original text when no exit is detected", () => {
    expect(stripExitPhrase("  just some dictation  ")).toBe(
      "just some dictation",
    );
  });

  it("preserves original offsets when lowercasing expands a character", () => {
    const text = "İstanbul stop, transcription";
    expect(isTranscriptionExitPhrase(text)).toBe(true);
    expect(stripExitPhrase(text)).toBe("İstanbul");
  });

  it("returns empty string for empty input", () => {
    expect(stripExitPhrase("")).toBe("");
    expect(stripExitPhrase(null)).toBe("");
    expect(stripExitPhrase(undefined)).toBe("");
  });
});
