/**
 * Unit coverage for extracting speakable text from assistant payloads (JSON with
 * text/actions vs plain). Pure function, no live TTS.
 */
import { describe, expect, it } from "vitest";
import {
  extractVoiceText,
  splitFirstSentence,
  toSpeakableText,
} from "./voice-chat-playback";

describe("extractVoiceText", () => {
  it("extracts text from JSON assistant payloads", () => {
    expect(
      extractVoiceText('{"text":"Hello there.","actions":["REPLY"]}'),
    ).toBe("Hello there.");
  });

  it("suppresses structured action payloads without text", () => {
    expect(
      extractVoiceText('{"actions":["BENCHMARK_ACTION"],"params":{"foo":1}}'),
    ).toBe("");
  });
});

describe("splitFirstSentence", () => {
  it("splits long sentence window safely when surrogate pairs appear near 180 chars", () => {
    const text = "A".repeat(170) + " " + "B".repeat(8) + "🚀" + " " + "C".repeat(50);
    const result = splitFirstSentence(text);
    expect(result.firstSentence.isWellFormed()).toBe(true);
    expect(result.remainder.isWellFormed()).toBe(true);
  });
});

describe("toSpeakableText", () => {
  it("preserves speakable content beyond the former 4k character boundary", () => {
    const longSpeech = `${"complete sentence. ".repeat(400)}final sentence.`;
    expect(longSpeech.length).toBeGreaterThan(4_000);
    expect(toSpeakableText(longSpeech)).toBe(longSpeech);
  });
});
