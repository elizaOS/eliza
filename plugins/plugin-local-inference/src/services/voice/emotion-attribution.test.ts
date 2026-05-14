import { describe, expect, it } from "vitest";
import { attributeVoiceEmotion } from "./emotion-attribution";
import { WAV2SMALL_INT8_MODEL_ID } from "./voice-emotion-classifier";

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

	it("fuses acoustic classifier output with text evidence and reports vad + acoustic_text_fused", () => {
		const result = attributeVoiceEmotion({
			text: "I am furious about this!",
			model: {
				output: {
					vad: { valence: 0.15, arousal: 0.85, dominance: 0.8 },
					emotion: "angry",
					confidence: 0.82,
					scores: {
						happy: 0.05,
						sad: 0.1,
						angry: 0.82,
						nervous: 0.2,
						calm: 0.0,
						excited: 0.3,
						whisper: 0.0,
					},
					modelId: WAV2SMALL_INT8_MODEL_ID,
					latencyMs: 4,
				},
			},
		});

		expect(result.emotion).toBe("angry");
		expect(result.method).toBe("acoustic_text_fused");
		expect(result.vad).toMatchObject({
			valence: 0.15,
			arousal: 0.85,
			dominance: 0.8,
		});
		expect(result.evidence.some((row) => row.source === "acoustic_model")).toBe(
			true,
		);
	});

	it("attributes acoustic_model alone when only the classifier output is provided", () => {
		const result = attributeVoiceEmotion({
			model: {
				output: {
					vad: { valence: 0.1, arousal: 0.1, dominance: 0.2 },
					emotion: "sad",
					confidence: 0.7,
					scores: {
						happy: 0.0,
						sad: 0.7,
						angry: 0.05,
						nervous: 0.1,
						calm: 0.1,
						excited: 0.0,
						whisper: 0.05,
					},
					modelId: WAV2SMALL_INT8_MODEL_ID,
					latencyMs: 3,
				},
			},
		});

		expect(result.emotion).toBe("sad");
		expect(result.method).toBe("acoustic_model");
		expect(result.modelNativeEmotion).toBe(false);
		expect(result.vad).toBeDefined();
	});
});
