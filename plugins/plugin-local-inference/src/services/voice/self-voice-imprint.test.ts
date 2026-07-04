/** Covers `AgentSelfVoiceImprint`: TTS-centroid building, the agent-specific
 * self-voice decision gate, and the shared #12255 handle. Deterministic, fake encoder. */
import { afterEach, describe, expect, it } from "vitest";
import {
	__resetAgentSelfVoiceImprintsForTest,
	AGENT_SELF_VOICE_IMPRINT_THRESHOLD,
	AgentSelfVoiceImprint,
	getAgentSelfVoiceImprint,
	registerAgentSelfVoiceImprint,
} from "./self-voice-imprint";
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

describe("AgentSelfVoiceImprint decision gate (#12256)", () => {
	it("decides self-voice at the agent-specific threshold, not the 0.78 human bar", async () => {
		const imprint = new AgentSelfVoiceImprint({
			encoder: queuedEncoder([unitEmbedding(0)]),
			minSamples: 16_000,
		});
		await imprint.observeAudio(new Float32Array(16_000).fill(0.1), 16_000);
		expect(imprint.ready).toBe(true);
		expect(imprint.threshold).toBe(AGENT_SELF_VOICE_IMPRINT_THRESHOLD);

		// The measured production margins: agent-self cosine ~0.37, human ~0.15.
		const selfLike = new Float32Array(256);
		selfLike[0] = 0.37;
		selfLike[2] = Math.sqrt(1 - 0.37 ** 2);
		const humanLike = new Float32Array(256);
		humanLike[0] = 0.15;
		humanLike[3] = Math.sqrt(1 - 0.15 ** 2);
		await expect(imprint.isAgentSelfVoice(selfLike)).resolves.toBe(true);
		await expect(imprint.isAgentSelfVoice(humanLike)).resolves.toBe(false);
	});

	it("returns null (fail-open) before any centroid exists", async () => {
		const imprint = new AgentSelfVoiceImprint({
			encoder: queuedEncoder([unitEmbedding(0)]),
		});
		expect(imprint.ready).toBe(false);
		await expect(
			imprint.isAgentSelfVoice(unitEmbedding(0)),
		).resolves.toBeNull();
	});
});

describe("shared imprint handle (#12255 contract)", () => {
	afterEach(() => __resetAgentSelfVoiceImprintsForTest());

	it("prefers the speak-back loop's registration over live-frames", () => {
		expect(getAgentSelfVoiceImprint()).toBeNull();
		const liveFrames = new AgentSelfVoiceImprint({
			encoder: queuedEncoder([unitEmbedding(0)]),
		});
		registerAgentSelfVoiceImprint("live-frames", liveFrames);
		expect(getAgentSelfVoiceImprint()).toBe(liveFrames);

		const speakBack = new AgentSelfVoiceImprint({
			encoder: queuedEncoder([unitEmbedding(1)]),
		});
		registerAgentSelfVoiceImprint("speak-back-loop", speakBack);
		expect(getAgentSelfVoiceImprint()).toBe(speakBack);
	});
});
