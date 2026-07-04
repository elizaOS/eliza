/**
 * AudioFrameConsumer windowed long-turn integration (#12257). Drives the
 * consumer with a manual VAD and an incremental fake pipeline to prove that a
 * long turn decodes each 5 s window DURING capture and only the trailing
 * partial window at speech-end — so post-endpoint attribution work is bounded
 * to one window. A pipeline without `beginTurn` still takes the one-shot path.
 */

import { describe, expect, it } from "vitest";
import {
	type AttributionPipelineLike,
	AudioFrameConsumer,
	type RuntimeEventSink,
	type VadSegmenter,
} from "./audio-frame-consumer";
import type {
	IncrementalTurnAttributor,
	VoiceAttributionOutput,
} from "./speaker/attribution-pipeline";
import type { PcmFrame, VadEvent } from "./types";

const SR = 16_000;
const WINDOW_SAMPLES = 5 * SR;

/** VAD the test drives directly — no Silero, no scripted probabilities. */
class ManualVad implements VadSegmenter {
	private readonly listeners = new Set<(e: VadEvent) => void>();
	onVadEvent(listener: (e: VadEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	async pushFrame(_frame: PcmFrame): Promise<void> {}
	async flush(): Promise<void> {}
	reset(): void {}
	emit(event: VadEvent): void {
		for (const l of this.listeners) l(event);
	}
}

function cannedOutput(turnId: string): VoiceAttributionOutput {
	return {
		turnId,
		primarySpeaker: {
			id: "spk",
			imprintClusterId: "cluster-1",
			entityId: "entity-x",
			confidence: 0.5,
		},
		segments: [],
		turn: { turnId },
		observation: {
			profileId: "prof-1",
			imprintClusterId: "cluster-1",
			entityId: "entity-x",
			embedding: new Float32Array(256),
			embeddingModel: "wespeaker",
			confidence: 0.5,
		},
	};
}

/** Records the incremental turn's window pushes and finalize. */
class IncrementalFakePipeline implements AttributionPipelineLike {
	attributeCalls = 0;
	beginTurnCalls = 0;
	readonly pushes: Array<{ length: number; startMs: number }> = [];
	finalizeArgs: {
		fullLength: number;
		finalWindowLength: number | undefined;
		finalWindowStartMs: number | undefined;
	} | null = null;

	async attribute(
		req: Parameters<AttributionPipelineLike["attribute"]>[0],
	): Promise<VoiceAttributionOutput> {
		this.attributeCalls += 1;
		return cannedOutput(req.turnId);
	}

	beginTurn(
		init: Parameters<NonNullable<AttributionPipelineLike["beginTurn"]>>[0],
	): IncrementalTurnAttributor {
		this.beginTurnCalls += 1;
		const pushes = this.pushes;
		let windowsDiarized = 0;
		const record = (args: typeof this.finalizeArgs) => {
			this.finalizeArgs = args;
		};
		let cancelled = false;
		return {
			get windowsDiarized() {
				return windowsDiarized;
			},
			speculativeMatch: {
				result: Promise.resolve(null),
				current: () => null,
				cancel: () => {
					cancelled = true;
				},
			},
			pushWindow: async (windowPcm, windowStartMs) => {
				windowsDiarized += 1;
				pushes.push({ length: windowPcm.length, startMs: windowStartMs });
			},
			finalize: async (args) => {
				record({
					fullLength: args.fullPcm.length,
					finalWindowLength: args.finalWindowPcm?.length,
					finalWindowStartMs: args.finalWindowStartMs,
				});
				expect(cancelled).toBe(false);
				return cannedOutput(init.turnId);
			},
		};
	}
}

class FakeRuntime implements RuntimeEventSink {
	readonly emitted: unknown[] = [];
	async emitEvent(
		type: unknown,
		payload: Record<string, unknown>,
	): Promise<void> {
		this.emitted.push({ type, payload });
	}
}

/** A pipeline with no `beginTurn` — forces the one-shot fallback. */
class OneShotFakePipeline implements AttributionPipelineLike {
	attributeCalls = 0;
	lastPcmLength = 0;
	async attribute(
		req: Parameters<AttributionPipelineLike["attribute"]>[0],
	): Promise<VoiceAttributionOutput> {
		this.attributeCalls += 1;
		this.lastPcmLength = req.pcm.length;
		return cannedOutput(req.turnId);
	}
}

function buildConsumer(pipeline: AttributionPipelineLike) {
	const vad = new ManualVad();
	const runtime = new FakeRuntime();
	const turns: string[] = [];
	const consumer = new AudioFrameConsumer(
		{ vad, pipeline, runtime },
		{ preRollSeconds: 0, maxTurnSeconds: 60 },
	);
	consumer.onTurn((t) => turns.push(t.turnId));
	return { vad, consumer, turns };
}

/** Push `seconds` of turn audio as 0.5 s decoded frames from `startMs`. */
async function pushSpeech(
	consumer: AudioFrameConsumer,
	seconds: number,
	startMs = 0,
): Promise<void> {
	const frames = Math.round(seconds / 0.5);
	for (let i = 0; i < frames; i += 1) {
		await consumer.pushDecodedFrame(
			new Float32Array(0.5 * SR),
			startMs + i * 500,
		);
	}
}

describe("AudioFrameConsumer windowed long-turn attribution (#12257)", () => {
	it("decodes each 5 s window during capture and only the trailing partial at speech-end", async () => {
		const pipeline = new IncrementalFakePipeline();
		const { vad, consumer, turns } = buildConsumer(pipeline);

		vad.emit({ type: "speech-start", timestampMs: 0, probability: 0.9 });
		await pushSpeech(consumer, 14); // 14 s → 28 frames → 224000 samples
		vad.emit({
			type: "speech-end",
			timestampMs: 14_000,
			speechDurationMs: 14_000,
		});
		await consumer.flush();

		// Two full windows decoded DURING the turn.
		expect(pipeline.pushes).toEqual([
			{ length: WINDOW_SAMPLES, startMs: 0 },
			{ length: WINDOW_SAMPLES, startMs: 5_000 },
		]);
		// Only a 4 s trailing partial decoded post-endpoint — never the 14 s turn.
		expect(pipeline.finalizeArgs).toEqual({
			fullLength: 14 * SR,
			finalWindowLength: 4 * SR,
			finalWindowStartMs: 10_000,
		});
		// No samples dropped: windows + trailing == whole turn.
		expect(
			pipeline.pushes.reduce((n, p) => n + p.length, 0) +
				(pipeline.finalizeArgs?.finalWindowLength ?? 0),
		).toBe(14 * SR);
		// The incremental path was taken, not the one-shot attribute().
		expect(pipeline.beginTurnCalls).toBe(1);
		expect(pipeline.attributeCalls).toBe(0);
		expect(turns).toHaveLength(1);
	});

	it("a turn ending on a window boundary leaves no trailing window to decode", async () => {
		const pipeline = new IncrementalFakePipeline();
		const { vad, consumer } = buildConsumer(pipeline);

		vad.emit({ type: "speech-start", timestampMs: 0, probability: 0.9 });
		await pushSpeech(consumer, 10); // exactly two windows
		vad.emit({
			type: "speech-end",
			timestampMs: 10_000,
			speechDurationMs: 10_000,
		});
		await consumer.flush();

		expect(pipeline.pushes).toHaveLength(2);
		expect(pipeline.finalizeArgs?.finalWindowLength).toBeUndefined();
	});

	it("falls back to one-shot attribute when the pipeline has no beginTurn", async () => {
		const pipeline = new OneShotFakePipeline();
		const { vad, consumer, turns } = buildConsumer(pipeline);

		vad.emit({ type: "speech-start", timestampMs: 0, probability: 0.9 });
		await pushSpeech(consumer, 12);
		vad.emit({
			type: "speech-end",
			timestampMs: 12_000,
			speechDurationMs: 12_000,
		});
		await consumer.flush();

		// One whole-turn attribute() call — the legacy path, unchanged.
		expect(pipeline.attributeCalls).toBe(1);
		expect(pipeline.lastPcmLength).toBe(12 * SR);
		expect(turns).toHaveLength(1);
	});
});
