import { describe, expect, test } from "vitest";
import {
  COMMITTED_SPEECH_PROTOCOL,
  CommittedSpeechProtocolError,
  CommittedSpeechSegmenter,
  initialCommittedSpeechValidationState,
  MAX_COMMITTED_SPEECH_SEGMENTS,
  parseCommittedSpeechSegment,
  validateCommittedSpeechSegment,
} from "./incremental-speech-segments";

const FIRST_SENTENCE =
  "This first complete sentence is deliberately long enough to speak.";

describe("committed incremental speech", () => {
  test("publishes the exact additive protocol name", () => {
    expect(COMMITTED_SPEECH_PROTOCOL).toBe("committed-segments-v1");
  });

  test("waits for a complete sentence plus lookahead before committing", () => {
    const segmenter = new CommittedSpeechSegmenter();
    expect(segmenter.observeModelDelta(FIRST_SENTENCE)).toEqual([]);
    expect(segmenter.observeModelDelta(" Another")).toEqual([
      {
        type: "voice_speech_segment",
        version: 1,
        sequence: 0,
        sourceStart: 0,
        sourceEnd: FIRST_SENTENCE.length,
        speechText: FIRST_SENTENCE,
      },
    ]);
  });

  test("assembles arbitrary chunks before checking secrets and structure", () => {
    for (const unsafe of [
      "The credential is sk_car_FAKEFAKEFAKEFAKE000000.",
      "Use `const answer = 42` in the implementation.",
      "Open https://example.com/private/path for the details.",
      "| Key | Value |\n| --- | --- |\n| a | b |",
    ]) {
      for (let split = 1; split < unsafe.length; split += 1) {
        const segmenter = new CommittedSpeechSegmenter();
        expect(segmenter.observeModelDelta(unsafe.slice(0, split))).toEqual([]);
        expect(
          segmenter.observeModelDelta(
            `${unsafe.slice(split)} A later token supplies lookahead.`,
          ),
        ).toEqual([]);
      }
    }
  });

  test("allows pre-commit rewrites and rejects post-commit divergence", () => {
    const segmenter = new CommittedSpeechSegmenter();
    expect(
      segmenter.observeModelSnapshot(
        "This initial sentence has a wrld typo and is long enough. Next",
      ),
    ).toHaveLength(1);
    expect(() =>
      segmenter.observeModelSnapshot(
        "This initial sentence has a world typo and is long enough. Next",
      ),
    ).toThrow(CommittedSpeechProtocolError);

    const beforeCommit = new CommittedSpeechSegmenter();
    expect(beforeCommit.observeModelSnapshot("Hello wrld")).toEqual([]);
    expect(beforeCommit.observeModelSnapshot("Hello world")).toEqual([]);
  });

  test("rejects malformed, non-contiguous, or reprojected consumer frames", () => {
    const authoritative = `${FIRST_SENTENCE} Another token.`;
    const parsed = parseCommittedSpeechSegment({
      type: "voice_speech_segment",
      version: 1,
      sequence: 0,
      sourceStart: 0,
      sourceEnd: FIRST_SENTENCE.length,
      speechText: FIRST_SENTENCE,
    });
    expect(parsed).not.toBeNull();
    if (!parsed) throw new Error("segment fixture did not parse");
    const next = validateCommittedSpeechSegment(
      parsed,
      authoritative,
      initialCommittedSpeechValidationState(),
    );
    expect(next).toEqual({
      nextSequence: 1,
      sourceEnd: FIRST_SENTENCE.length,
      speechChars: FIRST_SENTENCE.length,
    });
    expect(() =>
      validateCommittedSpeechSegment(
        { ...parsed, sequence: 2 },
        authoritative,
        initialCommittedSpeechValidationState(),
      ),
    ).toThrow(CommittedSpeechProtocolError);
    expect(() =>
      validateCommittedSpeechSegment(
        { ...parsed, speechText: "Different but superficially safe speech." },
        authoritative,
        initialCommittedSpeechValidationState(),
      ),
    ).toThrow(CommittedSpeechProtocolError);
  });

  test("stops at the bounded segment count", () => {
    const segmenter = new CommittedSpeechSegmenter();
    const text = Array.from(
      { length: MAX_COMMITTED_SPEECH_SEGMENTS + 2 },
      (_, index) =>
        `Sentence number ${index} contains enough ordinary words for safe speech.`,
    ).join(" ");
    const segments = segmenter.observeModelSnapshot(`${text} Lookahead`);
    expect(segments).toHaveLength(MAX_COMMITTED_SPEECH_SEGMENTS);
    expect(segments.map((segment) => segment.sequence)).toEqual(
      Array.from(
        { length: MAX_COMMITTED_SPEECH_SEGMENTS },
        (_, index) => index,
      ),
    );
  });
});
