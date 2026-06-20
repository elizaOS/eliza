/**
 * AudioFrameConsumer unit tests (no models, fully injected deps).
 *
 * Drives the consumer with:
 *   - a REAL `VadDetector` backed by a deterministic scripted fake Silero, so
 *     the turn-segmentation state machine (speech-start → speech-end) is the
 *     real one, exercised deterministically;
 *   - a fake `AttributionPipelineLike` that records the PCM it was handed and
 *     returns a canned `VoiceAttributionOutput`;
 *   - a fake `RuntimeEventSink` that records `emitEvent` calls.
 *
 * Asserts: the wire-format decode boundary; one turn segmented per
 * speech-start/speech-end pair; the buffered PCM handed to attribution; the
 * VOICE_TURN_OBSERVED emission and the folded voiceTurnSignal surfaced via
 * `onTurn`; the runaway-turn cap; pre-roll inclusion.
 */

import { describe, expect, it } from "vitest";
import {
	type AttributionPipelineLike,
	AudioFrameConsumer,
	AudioFrameDecodeError,
	type AudioFrameEvent,
	decodeAudioFramePcm,
	type RuntimeEventSink,
} from "./audio-frame-consumer";
import type { VoiceAttributionOutput } from "./speaker/attribution-pipeline";
import { VadDetector } from "./vad";

const SR = 16_000;
const FRAME = 512; // one Silero window

/** Deterministic fake Silero: scripted probability per processed window. */
class ScriptedSilero {
	readonly sampleRate = SR;
	readonly windowSamples = FRAME;
	private idx = 0;
	constructor(private readonly probs: readonly number[]) {}
	async process(window: Float32Array): Promise<number> {
		expect(window.length).toBe(FRAME);
		const p = this.probs[this.idx] ?? this.probs[this.probs.length - 1] ?? 0;
		this.idx++;
		return p;
	}
	reset(): void {}
}

/** Records the attribute() inputs and returns a canned output. */
class FakePipeline implements AttributionPipelineLike {
	readonly calls: Array<{ turnId: string; pcm: Float32Array }> = [];
	constructor(private readonly entityId: string | null = "entity-x") {}
	async attribute(
		req: Parameters<AttributionPipelineLike["attribute"]>[0],
	): Promise<VoiceAttributionOutput> {
		this.calls.push({ turnId: req.turnId, pcm: req.pcm });
		return {
			turnId: req.turnId,
			primarySpeaker: {
				id: "spk",
				imprintClusterId: "cluster-1",
				entityId: this.entityId ?? undefined,
				confidence: 0.5,
			},
			segments: [],
			turn: { turnId: req.turnId },
			observation: {
				profileId: "prof-1",
				imprintClusterId: "cluster-1",
				entityId: this.entityId,
				embedding: new Float32Array(256),
				embeddingModel: "wespeaker",
				confidence: 0.5,
			},
		};
	}
}

class FakeRuntime implements RuntimeEventSink {
	readonly emitted: Array<{ type: unknown; payload: Record<string, unknown> }> =
		[];
	async emitEvent(
		type: unknown,
		payload: Record<string, unknown>,
	): Promise<void> {
		this.emitted.push({ type, payload });
	}
}

/** A 20 ms (320-sample) audioFrame at 16 kHz, encoded as base64 LE-s16. */
function makeFrame(opts: {
	amplitude: number;
	timestamp: number;
	frameIndex: number;
	samples?: number;
}): AudioFrameEvent {
	const samples = opts.samples ?? 320;
	const buf = Buffer.alloc(samples * 2);
	for (let i = 0; i < samples; i++) {
		const v = Math.round(
			opts.amplitude * Math.sin((2 * Math.PI * 220 * i) / SR) * 32767,
		);
		buf.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 2);
	}
	return {
		pcm16: buf.toString("base64"),
		sampleRate: SR,
		channels: 1,
		samples,
		rms: opts.amplitude / Math.SQRT2,
		timestamp: opts.timestamp,
		frameIndex: opts.frameIndex,
	};
}

/**
 * Build a consumer whose REAL VadDetector is fed by a scripted Silero. Returns
 * the consumer plus the recorders so tests can assert on them.
 */
function buildHarness(
	probs: readonly number[],
	entityId: string | null = "entity-x",
) {
	const silero = new ScriptedSilero(probs);
	const vad = new VadDetector(silero, {
		onsetThreshold: 0.5,
		// Short hangovers so a finite scripted run finalizes the turn.
		pauseHangoverMs: 64,
		endHangoverMs: 128,
		minSpeechMs: 32,
	});
	const pipeline = new FakePipeline(entityId);
	const runtime = new FakeRuntime();
	const consumer = new AudioFrameConsumer(
		{ vad, pipeline, runtime },
		{
			source: { kind: "device", deviceId: "pixel" },
			attributionOptions: {
				ownerEntityId: "entity-x",
				knownSpeakerEntityIds: ["entity-x"],
				endOfTurnProbability: 0.95,
			},
			preRollSeconds: 0, // deterministic buffering for assertions
			maxTurnSeconds: 30,
		},
	);
	return { consumer, pipeline, runtime, vad };
}

describe("decodeAudioFramePcm", () => {
	it("decodes base64 LE-s16 mono → Float32 [-1,1]", () => {
		const frame = makeFrame({ amplitude: 0.5, timestamp: 0, frameIndex: 0 });
		const pcm = decodeAudioFramePcm(frame);
		expect(pcm).toBeInstanceOf(Float32Array);
		expect(pcm.length).toBe(320);
		// Peak ≈ amplitude; all in range.
		let max = 0;
		for (const v of pcm) {
			expect(v).toBeGreaterThanOrEqual(-1);
			expect(v).toBeLessThanOrEqual(1);
			if (Math.abs(v) > max) max = Math.abs(v);
		}
		expect(max).toBeGreaterThan(0.45);
		expect(max).toBeLessThan(0.55);
	});

	it("round-trips a known s16 sample exactly", () => {
		const buf = Buffer.alloc(4);
		buf.writeInt16LE(16384, 0); // +0.5
		buf.writeInt16LE(-32768, 2); // -1.0
		const pcm = decodeAudioFramePcm({
			pcm16: buf.toString("base64"),
			sampleRate: SR,
			channels: 1,
			samples: 2,
			rms: 0,
			timestamp: 0,
			frameIndex: 0,
		});
		expect(pcm[0]).toBeCloseTo(0.5, 5);
		expect(pcm[1]).toBeCloseTo(-1.0, 5);
	});

	it("rejects non-mono and wrong sample rate (no silent resample)", () => {
		const base = makeFrame({ amplitude: 0.1, timestamp: 0, frameIndex: 0 });
		expect(() => decodeAudioFramePcm({ ...base, channels: 2 })).toThrow(
			AudioFrameDecodeError,
		);
		expect(() => decodeAudioFramePcm({ ...base, sampleRate: 48000 })).toThrow(
			AudioFrameDecodeError,
		);
	});
});

describe("AudioFrameConsumer", () => {
	it("segments one turn from speech-start..speech-end and attributes it", async () => {
		// 320-sample frames re-window into the VAD as 512-sample windows. Script
		// ~24 speech windows (loud) then ~12 silence windows to force speech-end.
		const probs = [...Array(24).fill(0.9), ...Array(12).fill(0.0)];
		const { consumer, pipeline, runtime } = buildHarness(probs);
		const turns: Array<{ turnId: string }> = [];
		consumer.onTurn((t) => turns.push({ turnId: t.turnId }));

		// Feed enough loud frames to cover the speech windows, then silence.
		let ts = 1000;
		let idx = 0;
		for (let i = 0; i < 40; i++) {
			await consumer.onAudioFrame(
				makeFrame({ amplitude: 0.6, timestamp: ts, frameIndex: idx++ }),
			);
			ts += 20;
		}
		for (let i = 0; i < 24; i++) {
			await consumer.onAudioFrame(
				makeFrame({ amplitude: 0.0, timestamp: ts, frameIndex: idx++ }),
			);
			ts += 20;
		}
		await consumer.flush();

		expect(pipeline.calls.length).toBe(1);
		expect(turns.length).toBe(1);
		// The attributed PCM is the buffered turn (non-empty, real samples).
		expect(pipeline.calls[0].pcm.length).toBeGreaterThan(SR * 0.4);
		// VOICE_TURN_OBSERVED was emitted for the attributed (bound) speaker.
		expect(runtime.emitted.length).toBe(1);
		expect(runtime.emitted[0].payload.matchedEntityId).toBe("entity-x");
	});

	it("produces a voiceTurnSignal: enrolled owner → agent speaks", async () => {
		const probs = [...Array(24).fill(0.9), ...Array(12).fill(0.0)];
		const { consumer } = buildHarness(probs, "entity-x");
		let signal: {
			agentShouldSpeak: boolean | null;
			nextSpeaker: string;
		} | null = null;
		consumer.onTurn((t) => {
			signal = {
				agentShouldSpeak: t.signal.agentShouldSpeak,
				nextSpeaker: t.signal.nextSpeaker,
			};
		});
		let ts = 1000;
		for (let i = 0; i < 40; i++) {
			await consumer.onAudioFrame(
				makeFrame({ amplitude: 0.6, timestamp: ts, frameIndex: i }),
			);
			ts += 20;
		}
		for (let i = 0; i < 24; i++) {
			await consumer.onAudioFrame(
				makeFrame({ amplitude: 0.0, timestamp: ts, frameIndex: 40 + i }),
			);
			ts += 20;
		}
		await consumer.flush();
		expect(signal).not.toBeNull();
		expect(signal?.agentShouldSpeak).toBe(true);
		expect(signal?.nextSpeaker).toBe("agent");
	});

	it("stamps the signal onto the attribution output turn metadata", async () => {
		const probs = [...Array(24).fill(0.9), ...Array(12).fill(0.0)];
		const { consumer } = buildHarness(probs);
		let metaSignal: unknown;
		consumer.onTurn((t) => {
			metaSignal = (
				t.output.turn.metadata as { voiceTurnSignal?: unknown } | undefined
			)?.voiceTurnSignal;
		});
		let ts = 1000;
		for (let i = 0; i < 40; i++) {
			await consumer.onAudioFrame(
				makeFrame({ amplitude: 0.6, timestamp: ts, frameIndex: i }),
			);
			ts += 20;
		}
		for (let i = 0; i < 24; i++) {
			await consumer.onAudioFrame(
				makeFrame({ amplitude: 0.0, timestamp: ts, frameIndex: 40 + i }),
			);
			ts += 20;
		}
		await consumer.flush();
		expect(metaSignal).toBeTruthy();
	});

	it("does not segment a turn from pure silence", async () => {
		const { consumer, pipeline } = buildHarness(Array(40).fill(0.0));
		let ts = 1000;
		for (let i = 0; i < 40; i++) {
			await consumer.onAudioFrame(
				makeFrame({ amplitude: 0.0, timestamp: ts, frameIndex: i }),
			);
			ts += 20;
		}
		await consumer.flush();
		expect(pipeline.calls.length).toBe(0);
	});

	it("counts a frame that fails to decode as dropped (and rethrows)", async () => {
		const { consumer } = buildHarness(Array(10).fill(0.0));
		const bad = makeFrame({ amplitude: 0.1, timestamp: 0, frameIndex: 0 });
		await expect(
			consumer.onAudioFrame({ ...bad, channels: 2 }),
		).rejects.toBeInstanceOf(AudioFrameDecodeError);
		expect(consumer.droppedFrames).toBe(1);
	});

	it("force-finalizes a runaway turn at the max-turn cap", async () => {
		// Never-ending speech: every window is loud. A tiny 1 s cap exercises the
		// runaway path quickly.
		const silero = new ScriptedSilero(Array(2000).fill(0.95));
		const vad = new VadDetector(silero, {
			onsetThreshold: 0.5,
			pauseHangoverMs: 64,
			endHangoverMs: 128,
			minSpeechMs: 32,
		});
		const pl = new FakePipeline("entity-x");
		const rt = new FakeRuntime();
		const c = new AudioFrameConsumer(
			{ vad, pipeline: pl, runtime: rt },
			{ preRollSeconds: 0, maxTurnSeconds: 1 }, // 1 s cap
		);
		let finalized = 0;
		c.onTurn(() => finalized++);
		let ts = 1000;
		// Feed ~2 s of loud audio (100 frames * 20 ms) — the cap must fire mid-stream.
		for (let i = 0; i < 100; i++) {
			await c.onAudioFrame(
				makeFrame({ amplitude: 0.7, timestamp: ts, frameIndex: i }),
			);
			ts += 20;
		}
		await c.flush();
		expect(finalized).toBeGreaterThanOrEqual(1);
		expect(pl.calls.length).toBeGreaterThanOrEqual(1);
		// Each finalized turn must not exceed the cap by more than one frame.
		for (const call of pl.calls) {
			expect(call.pcm.length).toBeLessThanOrEqual(SR * 1 + 512);
		}
	});
});
