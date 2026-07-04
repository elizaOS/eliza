/** Covers `AgentSelfVoiceImprint` building the agent's own voice centroid from TTS output. Deterministic, fake encoder. */
import { describe, expect, it } from "vitest";
import { AgentSelfVoiceImprint } from "./self-voice-imprint";
import type { SpeakerEncoder } from "./speaker/encoder";

function unitEmbedding(index: number): Float32Array {
	const out = new Float32Array(256);
	out[index] = 1;
	return out;
}

function queuedEncoder(
	embeddings: readonly Float32Array[],
	seen: Float32Array[] = [],
): SpeakerEncoder {
	let cursor = 0;
	return {
		embeddingDim: 256,
		sampleRate: 16_000,
		async encode(pcm: Float32Array): Promise<Float32Array> {
			seen.push(new Float32Array(pcm));
			return embeddings[cursor++] ?? embeddings.at(-1) ?? unitEmbedding(0);
		},
		async dispose(): Promise<void> {},
	};
}

describe("AgentSelfVoiceImprint", () => {
	it("buffers TTS audio, resamples to WeSpeaker rate, and scores similarity", async () => {
		const encodedWindows: Float32Array[] = [];
		const imprint = new AgentSelfVoiceImprint({
			encoder: queuedEncoder([unitEmbedding(0)], encodedWindows),
		});

		await imprint.observeAudio(new Float32Array(12_000).fill(0.1), 24_000);
		expect(await imprint.similarity(unitEmbedding(0))).toBeNull();

		await imprint.observeAudio(new Float32Array(12_000).fill(0.1), 24_000);

		expect(encodedWindows).toHaveLength(1);
		expect(encodedWindows[0]?.length).toBe(16_000);
		await expect(imprint.similarity(unitEmbedding(0))).resolves.toBeCloseTo(1);
	});

	it("maintains a normalized rolling centroid of recent agent voice embeddings", async () => {
		const imprint = new AgentSelfVoiceImprint({
			encoder: queuedEncoder([unitEmbedding(0), unitEmbedding(1)]),
			minSamples: 16_000,
			maxEmbeddings: 2,
		});

		await imprint.observeAudio(new Float32Array(16_000).fill(0.1), 16_000);
		await imprint.observeAudio(new Float32Array(16_000).fill(0.2), 16_000);

		const diagonal = new Float32Array(256);
		diagonal[0] = Math.SQRT1_2;
		diagonal[1] = Math.SQRT1_2;
		await expect(imprint.similarity(diagonal)).resolves.toBeCloseTo(1);
	});
});
