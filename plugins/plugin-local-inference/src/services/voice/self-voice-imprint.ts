/**
 * Builds and maintains the agent's own voice centroid from its TTS output, so
 * the speaker-attribution pipeline can recognize (and exclude) the assistant's
 * playback as self rather than mis-attributing it to a human speaker. Encodes
 * recent agent-TTS segments through the speaker encoder into a running centroid.
 */
import { averageEmbeddings, type SpeakerEncoder } from "./speaker/encoder";
import {
	SPEAKER_GGML_MIN_SAMPLES,
	SPEAKER_GGML_SAMPLE_RATE,
} from "./speaker/encoder-ggml";
import { cosineSimilarity } from "./speaker-imprint";
import { resampleLinear } from "./transcriber";

export interface AgentSelfVoiceImprintOptions {
	encoder: SpeakerEncoder;
	/** Minimum 16 kHz samples before one self-voice embedding is encoded. */
	minSamples?: number;
	/** Maximum 16 kHz samples to encode for one centroid update. */
	maxSamples?: number;
	/** Number of recent agent-TTS embeddings retained in the centroid. */
	maxEmbeddings?: number;
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

/**
 * Maintains a bounded centroid of the agent's own synthesized voice.
 *
 * The live mic path already gets WeSpeaker embeddings from attribution. This
 * helper observes the PCM that the scheduler hands to audio output, embeds that
 * actual TTS audio, and exposes cosine similarity against future mic turns.
 */
export class AgentSelfVoiceImprint {
	private readonly encoder: SpeakerEncoder;
	private readonly minSamples: number;
	private readonly maxSamples: number;
	private readonly maxEmbeddings: number;
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
