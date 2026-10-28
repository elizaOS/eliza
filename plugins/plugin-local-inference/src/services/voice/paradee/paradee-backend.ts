/**
 * Paradee-8M v1.1 TTS backend for the desktop agent voice pipeline.
 *
 * Implements the same `TtsBackend + StreamingTtsBackend` seam as the Kokoro
 * backend it replaces as the product default, so the `VoiceScheduler` keeps
 * its contracts unchanged:
 *   - phrase chunking: the scheduler's `PhraseChunker` still cuts the reply
 *     into phrases; each phrase is one or more worker requests (text longer
 *     than the worker's 500-character limit is split at sentence, then word,
 *     boundaries, preserving every character in order),
 *   - streaming: each request's PCM is surfaced in `streamingChunkSamples`
 *     slices (250 ms by default) so the ring buffer fills at the same cadence
 *     as Kokoro's one-forward-then-slice path,
 *   - barge-in / cancel: `cancelSignal.cancelled` is polled while a request is
 *     queued or running; the client then sends `{op:"cancel"}`, which reaches
 *     `eliza_inference_cancel_tts` in the worker, and no further slice is
 *     delivered,
 *   - the final empty `isFinal` tail is always emitted.
 *
 * Synthesis runs out of process in `host-tts-worker` on libelizainference: the
 * worker verifies the library digest and the pinned model files before
 * loading, phonemizes with the native misaki G2P (eSpeak NG data when staged),
 * and has no download or cloud fallback.
 *
 * Paradee ships one voice; `SpeakerPreset.voiceId` is ignored.
 */

import {
	createEvictableModelRole,
	type EvictableModelRole,
	type MmapRegionHandle,
} from "../shared-resources";
import type {
	AudioChunk,
	Phrase,
	SpeakerPreset,
	StreamingTtsBackend,
	TtsBackend,
	TtsPcmChunk,
} from "../types";
import {
	HostTtsClient,
	type HostTtsClientOptions,
	PARADEE_WORKER_MAX_TEXT_CHARS,
	ParadeeSpeechCancelledError,
} from "./host-tts-client";
import {
	PARADEE_MODEL_FILES,
	PARADEE_SAMPLE_RATE,
	PARADEE_VOICE_ID,
	type ParadeeEngineConfig,
} from "./paradee-engine-discovery";

/** Requests stay well under the worker's 500-character and 60 s limits. */
export const PARADEE_MAX_REQUEST_CHARS = 400;

/**
 * Split text into ordered pieces of at most `limit` characters. Sentence ends
 * are preferred, then whitespace; a single unbroken run longer than `limit`
 * is cut hard. Concatenating the pieces returns the input exactly.
 */
export function splitParadeeText(
	text: string,
	limit = PARADEE_MAX_REQUEST_CHARS,
): string[] {
	if (limit < 1 || limit > PARADEE_WORKER_MAX_TEXT_CHARS) {
		throw new Error(`[paradee] invalid request limit ${limit}`);
	}
	const pieces: string[] = [];
	let rest = text;
	while (rest.length > limit) {
		const window = rest.slice(0, limit + 1);
		let cut = -1;
		const sentence = /[.!?;:]["')\]]*\s+/g;
		for (let m = sentence.exec(window); m; m = sentence.exec(window)) {
			const end = m.index + m[0].length;
			if (end <= limit) cut = end;
		}
		if (cut <= 0) {
			const space = window.lastIndexOf(" ", limit);
			cut = space > 0 ? space + 1 : limit;
		}
		pieces.push(rest.slice(0, cut));
		rest = rest.slice(cut);
	}
	if (rest.length > 0) pieces.push(rest);
	return pieces;
}

/** Mono PCM16 WAV (the worker's format) to float PCM. */
export function wavToFloat32(wav: Buffer): {
	pcm: Float32Array;
	sampleRate: number;
} {
	if (
		wav.toString("ascii", 0, 4) !== "RIFF" ||
		wav.toString("ascii", 8, 12) !== "WAVE"
	) {
		throw new Error("[paradee] not a WAV");
	}
	let offset = 12;
	let sampleRate = 0;
	let channels = 0;
	let bits = 0;
	while (offset + 8 <= wav.length) {
		const id = wav.toString("ascii", offset, offset + 4);
		const size = wav.readUInt32LE(offset + 4);
		const body = offset + 8;
		if (id === "fmt ") {
			channels = wav.readUInt16LE(body + 2);
			sampleRate = wav.readUInt32LE(body + 4);
			bits = wav.readUInt16LE(body + 14);
		} else if (id === "data") {
			if (channels !== 1 || bits !== 16 || sampleRate <= 0) {
				throw new Error("[paradee] expected mono PCM16 WAV");
			}
			const end = Math.min(wav.length, body + size);
			const count = Math.floor((end - body) / 2);
			const pcm = new Float32Array(count);
			for (let i = 0; i < count; i++) {
				const v = wav.readInt16LE(body + i * 2);
				pcm[i] = v < 0 ? v / 32768 : v / 32767;
			}
			return { pcm, sampleRate };
		}
		offset = body + size + (size % 2);
	}
	throw new Error("[paradee] WAV has no data chunk");
}

/** Minimal synthesis surface; `HostTtsClient` in production, fakes in tests. */
export interface ParadeeSynthesizer {
	synthesize(text: string, isCancelled: () => boolean): Promise<Buffer>;
	initialize?(): Promise<void>;
	readonly running: boolean;
	unload(): Promise<void>;
	dispose(): void;
}

export interface ParadeeTtsBackendOptions {
	synthesizer: ParadeeSynthesizer;
	/** PCM slice size delivered to the scheduler. Default: 250 ms. */
	streamingChunkSamples?: number;
}

let nextParadeeRegion = 0;

export class ParadeeTtsBackend implements TtsBackend, StreamingTtsBackend {
	readonly id = "paradee" as const;
	readonly sampleRate = PARADEE_SAMPLE_RATE;
	private readonly synthesizer: ParadeeSynthesizer;
	private readonly streamingChunkSamples: number;

	constructor(opts: ParadeeTtsBackendOptions) {
		this.synthesizer = opts.synthesizer;
		this.streamingChunkSamples =
			opts.streamingChunkSamples ?? Math.floor(PARADEE_SAMPLE_RATE / 4);
	}

	supportsStreamingTts(): boolean {
		return true;
	}

	/** Weight and lexicon bytes; excludes transient synthesis allocations. */
	get residentModelMb(): number {
		return this.synthesizer.running
			? PARADEE_MODEL_FILES.reduce((bytes, file) => bytes + file.bytes, 0) /
					1024 ** 2
			: 0;
	}

	/** The same registry that owns text models can reclaim this worker. */
	async acquireMemoryRegion(): Promise<MmapRegionHandle & EvictableModelRole> {
		await this.warmUp();
		const sizeBytes = PARADEE_MODEL_FILES.reduce(
			(bytes, file) => bytes + file.bytes,
			0,
		);
		const unload = () => this.synthesizer.unload();
		return {
			...createEvictableModelRole({
				id: `paradee:tts:${nextParadeeRegion++}`,
				role: "tts",
				estimatedMb: sizeBytes / 1024 ** 2,
				isResident: () => this.synthesizer.running,
				evict: unload,
				release: unload,
			}),
			path: "",
			sizeBytes,
			evictPages: unload,
		};
	}

	/** Start the worker ahead of the first phrase (loads + warms the model). */
	async warmUp(): Promise<void> {
		await this.synthesizer.initialize?.();
	}

	async synthesize(args: {
		phrase: Phrase;
		preset: SpeakerPreset;
		cancelSignal: { cancelled: boolean };
		onKernelTick?: () => void;
	}): Promise<AudioChunk> {
		const parts: Float32Array[] = [];
		let total = 0;
		await this.synthesizeStream({
			...args,
			onChunk: ({ pcm, isFinal }) => {
				if (!isFinal && pcm.length > 0) {
					parts.push(pcm);
					total += pcm.length;
				}
				return args.cancelSignal.cancelled;
			},
		});
		const pcm = new Float32Array(total);
		let off = 0;
		for (const part of parts) {
			pcm.set(part, off);
			off += part.length;
		}
		return {
			phraseId: args.phrase.id,
			fromIndex: args.phrase.fromIndex,
			toIndex: args.phrase.toIndex,
			pcm,
			sampleRate: this.sampleRate,
		};
	}

	async synthesizeStream(args: {
		phrase: Phrase;
		preset: SpeakerPreset;
		cancelSignal: { cancelled: boolean };
		onChunk: (chunk: TtsPcmChunk) => boolean | undefined;
		onKernelTick?: () => void;
	}): Promise<{ cancelled: boolean }> {
		let cancelled = false;
		const isCancelled = () => cancelled || args.cancelSignal.cancelled;
		const pieces = splitParadeeText(args.phrase.text).filter((piece) =>
			/[\p{L}\p{N}]/u.test(piece),
		);
		for (const piece of pieces) {
			if (isCancelled()) {
				cancelled = true;
				break;
			}
			args.onKernelTick?.();
			let wav: Buffer;
			try {
				wav = await this.synthesizer.synthesize(piece.trim(), isCancelled);
			} catch (error) {
				if (error instanceof ParadeeSpeechCancelledError || isCancelled()) {
					cancelled = true;
					break;
				}
				throw error;
			}
			const { pcm, sampleRate } = wavToFloat32(wav);
			if (sampleRate !== this.sampleRate) {
				throw new Error(
					`[paradee] worker returned ${sampleRate} Hz, expected ${this.sampleRate} Hz`,
				);
			}
			for (let off = 0; off < pcm.length; off += this.streamingChunkSamples) {
				if (isCancelled()) {
					cancelled = true;
					break;
				}
				args.onKernelTick?.();
				const stop = args.onChunk({
					pcm: pcm.subarray(
						off,
						Math.min(pcm.length, off + this.streamingChunkSamples),
					),
					sampleRate: this.sampleRate,
					isFinal: false,
				});
				if (stop === true) {
					cancelled = true;
					break;
				}
			}
			if (cancelled) break;
		}
		args.onChunk({
			pcm: new Float32Array(0),
			sampleRate: this.sampleRate,
			isFinal: true,
		});
		return { cancelled: cancelled || args.cancelSignal.cancelled };
	}

	/** Stop the host worker. */
	dispose(): void {
		this.synthesizer.dispose();
	}
}

/** Production backend: Paradee through `host-tts-worker`. */
export function createParadeeTtsBackend(
	config: ParadeeEngineConfig,
	clientOptions: Omit<HostTtsClientOptions, "config"> = {},
): ParadeeTtsBackend {
	return new ParadeeTtsBackend({
		synthesizer: new HostTtsClient({ ...clientOptions, config }),
	});
}

/** Scheduler preset for Paradee (single voice; no embedding). */
export function createParadeeSpeakerPreset(): SpeakerPreset {
	return {
		voiceId: PARADEE_VOICE_ID,
		embedding: new Float32Array(0),
		bytes: new Uint8Array(0),
	};
}
