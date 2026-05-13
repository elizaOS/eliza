import { describe, expect, it } from "vitest";
import { attributeVoiceEmotion } from "./emotion-attribution";

describe("emotion-attribution", () => {
  it("prefers explicit expressive text tags and marks attribution as non-native", () => {
    const result = attributeVoiceEmotion({
      text: "[excited] That is amazing news!",
      audio: { durationMs: 1200, rms: 0.2, zeroCrossingRate: 0.08 },
    });

    expect(result.emotion).toBe("excited");
    expect(result.method).toBe("text_tag");
    expect(result.modelNativeEmotion).toBe(false);
    expect(result.evidence[0]).toMatchObject({
      source: "text_expressive_tag",
      detail: "[excited]",
    });
  });

  it("uses ASR transcript and audio features without claiming model-native emotion labels", () => {
    const result = attributeVoiceEmotion({
      asr: {
        transcript: "I am worried this might break",
        confidence: 0.91,
        emotionLabel: "anger",
        emotionLabelSupported: false,
      },
      audio: {
        durationMs: 1100,
        rms: 0.22,
        zeroCrossingRate: 0.11,
        speechRateWpm: 180,
      },
    });

    expect(result.emotion).toBe("nervous");
    expect(result.method).toBe("text_audio_heuristic");
    expect(result.modelNativeEmotion).toBe(false);
    expect(result.evidence).toContainEqual({
      source: "asr_emotion_metadata_ignored",
      detail: "anger",
      confidence: 0,
    });
    expect(result.evidence.some((row) => row.source === "asr_transcript")).toBe(
      true,
    );
  });

  it("can use explicitly supported ASR emotion metadata but still labels it as metadata", () => {
    const result = attributeVoiceEmotion({
      asr: {
        transcript: "I am okay",
        emotionLabel: "happiness",
        emotionLabelSupported: true,
      },
    });

    expect(result.emotion).toBe("happy");
    expect(result.method).toBe("explicit_asr_metadata");
    expect(result.modelNativeEmotion).toBe(false);
    expect(
      result.evidence.some((row) => row.source === "asr_emotion_metadata"),
    ).toBe(true);
  });
});
