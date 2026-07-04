/**
 * Bounded centroid of the agent's own synthesized voice, with the
 * agent-specific self-voice decision the echo defense's third layer gates on
 * (#12256, layered after the cooldown gate and the NLMS canceller).
 *
 * The live mic path already gets WeSpeaker embeddings from attribution. This
 * helper observes the PCM the agent actually renders (Pipeline B: the
 * scheduler's audio chunks; Pipeline A: the playback frames the renderer
 * streams back), embeds that audio, and exposes cosine similarity of future
 * mic turns against the centroid. The decision threshold is
 * `AGENT_SELF_VOICE_IMPRINT_THRESHOLD` (0.28): the agent's synthetic voice
 * embeds ~0.37 self-similar vs ~0.15 for humans (VOICE_8785_ASSESSMENT §6) —
 * a real margin, but far below the 0.78 human-enrollment bar, which is why the
 * imprint carries its own threshold instead of reusing the profile store's.
 *
 * Handle contract for #12255 (speaker-gated barge-in), mirroring the
 * profile-store factory's (#12257): the production pipelines register their
 * live imprint here at construction; barge-in gating calls
 * `getAgentSelfVoiceImprint()` (no args) and uses `isAgentSelfVoice(embedding)`
 * — never constructs its own imprint or re-derives the threshold. A `null`
 * gate result means "no centroid yet" (the agent has not spoken enough) and
 * MUST fail open (treat as not-self), never as self-voice.
 */

import { AGENT_SELF_VOICE_IMPRINT_THRESHOLD } from "@elizaos/shared/voice/respond-gate";
import { averageEmbeddings, type SpeakerEncoder } from "./speaker/encoder";
import {
	SPEAKER_GGML_MIN_SAMPLES,
	SPEAKER_GGML_SAMPLE_RATE,
} from "./speaker/encoder-ggml";
import { cosineSimilarity } from "./speaker-imprint";
import { resampleLinear } from "./transcriber";

export { AGENT_SELF_VOICE_IMPRINT_THRESHOLD };

export interface AgentSelfVoiceImprintOptions {
	encoder: SpeakerEncoder;
	/** Minimum 16 kHz samples before one self-voice embedding is encoded. */
	minSamples?: number;
	/** Maximum 16 kHz samples to encode for one centroid update. */
	maxSamples?: number;
	/** Number of recent agent-TTS embeddings retained in the centroid. */
	maxEmbeddings?: number;
	/**
	 * Cosine at/above which a turn embedding is decided to be the agent's own
	 * voice. Default {@link AGENT_SELF_VOICE_IMPRINT_THRESHOLD} (0.28; safe
	 * range 0.25–0.30 per the measured self/human margins).
	 */
	similarityThreshold?: number;
}

function concatSegments(
	segments: readonly Float32Array[],
	totalSamples: number,
): Float32Array {
	const out = new Float32Array(totalSamples);
	let offset = 0;
	for (const segment of segments) {
		out.set(segment, offset);
		offset += segment.length;
	}
	return out;
}

export class AgentSelfVoiceImprint {
	private readonly encoder: SpeakerEncoder;
	private readonly minSamples: number;
	private readonly maxSamples: number;
	private readonly maxEmbeddings: number;
	private readonly similarityThreshold: number;
	private readonly pendingSegments: Float32Array[] = [];
	private pendingSamples = 0;
	private readonly embeddings: Float32Array[] = [];
	private centroid: Float32Array | null = null;
	private queue: Promise<void> = Promise.resolve();

	constructor(options: AgentSelfVoiceImprintOptions) {
		this.encoder = options.encoder;
		this.minSamples = options.minSamples ?? SPEAKER_GGML_MIN_SAMPLES;
		this.maxSamples = options.maxSamples ?? SPEAKER_GGML_SAMPLE_RATE * 6;
		this.maxEmbeddings = Math.max(1, options.maxEmbeddings ?? 8);
		this.similarityThreshold =
			options.similarityThreshold ?? AGENT_SELF_VOICE_IMPRINT_THRESHOLD;
	}

	/** The agent-specific decision threshold this imprint applies. Consumers
	 * that forward the raw similarity into a gate pass this alongside it. */
	get threshold(): number {
		return this.similarityThreshold;
	}

	/** True once at least one centroid update has been encoded. */
	get ready(): boolean {
		return this.centroid !== null;
	}

	observeAudio(pcm: Float32Array, sampleRate: number): Promise<void> {
		const work = this.queue.then(() =>
			this.observeAudioLocked(pcm, sampleRate),
		);
		this.queue = work.catch(() => {});
		return work;
	}

	async similarity(embedding: Float32Array): Promise<number | null> {
		await this.queue;
		if (!this.centroid) return null;
		if (embedding.length !== this.centroid.length) return null;
		return cosineSimilarity(embedding, this.centroid);
	}

	/**
	 * The speaker-gate decision for #12255: does this turn embedding match the
	 * agent's own TTS voice? `null` while no centroid exists yet (or on a
	 * dimension mismatch) — callers MUST fail open on `null`.
	 */
	async isAgentSelfVoice(embedding: Float32Array): Promise<boolean | null> {
		const similarity = await this.similarity(embedding);
		if (similarity === null) return null;
		return similarity >= this.similarityThreshold;
	}

	private async observeAudioLocked(
		pcm: Float32Array,
		sampleRate: number,
	): Promise<void> {
		if (pcm.length === 0 || sampleRate <= 0) return;
		const speakerPcm =
			sampleRate === SPEAKER_GGML_SAMPLE_RATE
				? new Float32Array(pcm)
				: resampleLinear(pcm, sampleRate, SPEAKER_GGML_SAMPLE_RATE);
		if (speakerPcm.length === 0) return;

		this.pendingSegments.push(speakerPcm);
		this.pendingSamples += speakerPcm.length;
		if (this.pendingSamples < this.minSamples) return;

		const toEncode = concatSegments(this.pendingSegments, this.pendingSamples);
		this.pendingSegments.length = 0;
		this.pendingSamples = 0;

		const window =
			toEncode.length > this.maxSamples
				? toEncode.subarray(0, this.maxSamples)
				: toEncode;
		const embedding = await this.encoder.encode(window);
		this.embeddings.push(embedding);
		while (this.embeddings.length > this.maxEmbeddings) {
			this.embeddings.shift();
		}
		this.centroid = averageEmbeddings(this.embeddings);
	}
}

// ---------------------------------------------------------------------------
// Shared per-process handle (#12255 consumes this)
// ---------------------------------------------------------------------------

/** Which production pipeline registered an imprint. The speak-back loop's is
 * preferred: barge-in runs inside it, and its imprint observes the exact PCM
 * the scheduler hands to audio output. */
export type AgentSelfVoiceImprintSource = "speak-back-loop" | "live-frames";

const registeredImprints = new Map<
	AgentSelfVoiceImprintSource,
	AgentSelfVoiceImprint
>();

/** Register a production imprint under its pipeline source. Re-registration
 * (a voice restart) replaces the previous instance for that source. */
export function registerAgentSelfVoiceImprint(
	source: AgentSelfVoiceImprintSource,
	imprint: AgentSelfVoiceImprint,
): void {
	registeredImprints.set(source, imprint);
}

/**
 * The live production imprint, or null when no voice pipeline has constructed
 * one yet. Prefers the speak-back loop's (see {@link AgentSelfVoiceImprintSource}).
 */
export function getAgentSelfVoiceImprint(): AgentSelfVoiceImprint | null {
	return (
		registeredImprints.get("speak-back-loop") ??
		registeredImprints.get("live-frames") ??
		null
	);
}

/** Drop all registered imprints. Test-only. */
export function __resetAgentSelfVoiceImprintsForTest(): void {
	registeredImprints.clear();
}
