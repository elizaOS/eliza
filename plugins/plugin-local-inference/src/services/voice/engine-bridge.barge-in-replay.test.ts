/**
 * A barge-in must never hand the sink audio it already received. With the
 * streaming TTS path (the bridge default), every chunk is also queued for the
 * prefix-preserving rollback; once a chunk has reached the sink it has been
 * played or is playing, so the rollback must not write it out again.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineVoiceBridge } from "./engine-bridge";
import type { VoiceLifecycleLoaders } from "./lifecycle";
import { FIRST_AUDIO_FILLERS } from "./phrase-cache";
import type { MmapRegionHandle, RefCountedResource } from "./shared-resources";
import type {
	AudioSink,
	StreamingTtsBackend,
	TtsBackend,
	VadEvent,
	VadEventListener,
} from "./types";
import { writeVoicePresetFile } from "./voice-preset-format";

const SAMPLE_RATE = 24_000;
// One second per chunk keeps the agent "speaking" while the test drives VAD.
const CHUNK_SAMPLES = SAMPLE_RATE;

function writePresetBundle(root: string): void {
	mkdirSync(path.join(root, "cache"), { recursive: true });
	const embedding = new Float32Array(16);
	for (let i = 0; i < embedding.length; i++) embedding[i] = (i + 1) / 100;
	writeFileSync(
		path.join(root, "cache", "voice-preset-default.bin"),
		Buffer.from(writeVoicePresetFile({ embedding, phrases: [] })),
	);
}

function lifecycleLoadersOk(): VoiceLifecycleLoaders {
	const region: MmapRegionHandle = {
		id: "region-ok",
		path: "/tmp/tts-ok",
		sizeBytes: 1024,
		async evictPages() {},
		async release() {},
	};
	const refc: RefCountedResource = { id: "refc-ok", async release() {} };
	return {
		loadTtsRegion: async () => region,
		loadAsrRegion: async () => region,
		loadVoiceCaches: async () => refc,
		loadVoiceSchedulerNodes: async () => refc,
	};
}

/** Streams two body chunks per phrase, like Kokoro and the fused FFI build. */
function streamingBackend(): TtsBackend & StreamingTtsBackend {
	return {
		async synthesize({ phrase }) {
			return {
				phraseId: phrase.id,
				fromIndex: phrase.fromIndex,
				toIndex: phrase.toIndex,
				pcm: new Float32Array(2 * CHUNK_SAMPLES),
				sampleRate: SAMPLE_RATE,
			};
		},
		async synthesizeStream({ onChunk }) {
			for (let i = 0; i < 2; i++) {
				onChunk({
					pcm: new Float32Array(CHUNK_SAMPLES),
					sampleRate: SAMPLE_RATE,
					isFinal: false,
				});
			}
			onChunk({
				pcm: new Float32Array(0),
				sampleRate: SAMPLE_RATE,
				isFinal: true,
			});
			return { cancelled: false };
		},
	};
}

class RecordingSink implements AudioSink {
	written = 0;
	private buffered = 0;

	write(pcm: Float32Array): void {
		this.written += pcm.length;
		this.buffered += pcm.length;
	}

	drain(): void {
		this.buffered = 0;
	}

	bufferedSamples(): number {
		return this.buffered;
	}
}

class ManualVad {
	private listener: VadEventListener | null = null;

	onVadEvent(listener: VadEventListener): () => void {
		this.listener = listener;
		return () => {
			this.listener = null;
		};
	}

	emit(event: VadEvent): void {
		this.listener?.(event);
	}
}

describe("EngineVoiceBridge barge-in with streaming TTS", () => {
	let bundleRoot: string;
	let sink: RecordingSink;
	let bridge: EngineVoiceBridge;
	let nextIndex: number;

	beforeEach(async () => {
		bundleRoot = mkdtempSync(path.join(tmpdir(), "eliza-barge-in-replay-"));
		writePresetBundle(bundleRoot);
		sink = new RecordingSink();
		bridge = EngineVoiceBridge.start({
			bundleRoot,
			useFfiBackend: false,
			lifecycleLoaders: lifecycleLoadersOk(),
			backendOverride: streamingBackend(),
			sink,
		});
		await bridge.arm();
		nextIndex = 0;
	});

	afterEach(() => {
		rmSync(bundleRoot, { recursive: true, force: true });
	});

	/** Streams one reply piece by piece, as `engine.ts` does. */
	async function speak(pieces: string[]): Promise<void> {
		for (const text of pieces) {
			await bridge.pushAcceptedToken({ index: nextIndex++, text });
		}
		await bridge.settle();
	}

	it("does not write already-played audio to the sink again", async () => {
		await speak(["Hello", " there", ".", " How", " are", " you", "?"]);
		const written = sink.written;
		expect(written).toBe(4 * CHUNK_SAMPLES);

		bridge.triggerBargeIn();

		expect(sink.written).toBe(written);
	});

	it("does not replay audio that played after a provisional pause", async () => {
		const vad = new ManualVad();
		bridge.scheduler.bargeIn.bindVad(vad);
		await speak(["Hello", " there", "."]);
		expect(sink.written).toBe(2 * CHUNK_SAMPLES);

		// Background noise pauses TTS; the next phrase is held in the ring buffer.
		vad.emit({ type: "speech-start", timestampMs: 1, probability: 0.9 });
		expect(bridge.scheduler.ttsPaused).toBe(true);
		await speak([" How", " are", " you", "?"]);
		expect(sink.written).toBe(2 * CHUNK_SAMPLES);

		// The noise was not speech: playback resumes with the held phrase.
		vad.emit({ type: "blip", timestampMs: 2, durationMs: 1, peakRms: 0.01 });
		expect(sink.written).toBe(4 * CHUNK_SAMPLES);

		bridge.triggerBargeIn();

		expect(sink.written).toBe(4 * CHUNK_SAMPLES);
		bridge.scheduler.bargeIn.unbindVad();
	});

	it("does not replay held audio that a first-audio filler played", async () => {
		const vad = new ManualVad();
		bridge.scheduler.bargeIn.bindVad(vad);
		await bridge.prewarmPhrases([FIRST_AUDIO_FILLERS[0]]);
		await speak(["Hello", " there", "."]);
		expect(sink.written).toBe(2 * CHUNK_SAMPLES);

		// The user starts talking; the next phrase is held in the ring buffer.
		vad.emit({ type: "speech-start", timestampMs: 1, probability: 0.9 });
		expect(bridge.scheduler.ttsPaused).toBe(true);
		await speak([" How", " are", " you", "?"]);
		expect(sink.written).toBe(2 * CHUNK_SAMPLES);

		// The turn controller plays the filler on a speech onset. It flushes the
		// whole ring buffer, so the held phrase reaches the sink with it.
		expect(bridge.playFirstAudioFiller()).toBe(FIRST_AUDIO_FILLERS[0]);
		const written = sink.written;
		expect(written).toBe(6 * CHUNK_SAMPLES);
		expect(bridge.scheduler.prefixQueue.size).toBe(0);

		bridge.triggerBargeIn();

		expect(sink.written).toBe(written);
		bridge.scheduler.bargeIn.unbindVad();
	});

	it("keeps no played audio queued for rollback across replies", async () => {
		for (let reply = 0; reply < 3; reply++) {
			await speak(["Reply", ` ${reply}`, " done", "."]);
			expect(bridge.scheduler.prefixQueue.size).toBe(0);
		}
	});
});
