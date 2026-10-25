/**
 * Regression test for the #8786 in-process transcript join.
 *
 * `runVoiceTurn` runs speaker-attribution in parallel with the ASR pipeline.
 * The attribution result drives `handleLiveVoiceAttribution`, which emits
 * `VOICE_TURN_OBSERVED` so the merge engine can fold the turn into the entity
 * graph. Historically the emit carried an empty `text` because the in-process
 * engine never threaded the turn's ASR transcript into the attribution call —
 * so the merge engine knew *who* spoke but never *what* they said, and live
 * name extraction (`VoiceObserver.ingestTurn`) could not fire.
 *
 * These tests assert the join: the transcript produced inside the pipeline
 * (`onAsrComplete`) rides on `VOICE_TURN_OBSERVED` for the same turn. They mock
 * the attribution + pipeline seams (no model, no FFI, no live voice loop) so the
 * correlation logic is exercised in isolation.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { EventType } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineVoiceBridge } from "./engine-bridge";
import type { VoiceLifecycleLoaders } from "./lifecycle";
import type { MtpTextRunner } from "./pipeline-impls";
import type { MmapRegionHandle, RefCountedResource } from "./shared-resources";
import type { VoiceAttributionOutput } from "./speaker/attribution-pipeline";
import { writeVoicePresetFile } from "./voice-preset-format";

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

function unitEmbedding(index = 0): Float32Array {
	const out = new Float32Array(256);
	out[index] = 1;
	return out;
}

/** Attribution output with a bound speaker (drives the VOICE_TURN_OBSERVED emit). */
function attributionOutput(
	embedding: Float32Array = unitEmbedding(),
): VoiceAttributionOutput {
	return {
		turnId: "t1",
		primarySpeaker: { entityId: "entity-jill", confidence: 0.6 },
		observation: {
			imprintClusterId: "cluster-1",
			confidence: 0.6,
			entityId: "entity-jill",
			embedding,
		},
		turn: { metadata: {} },
		segments: [],
	} as unknown as VoiceAttributionOutput;
}

/**
 * Capture `VOICE_TURN_OBSERVED` emits and expose a promise that resolves once the
 * first one lands (attribution is fire-and-forget, so the test must wait for it).
 */
function captureRuntime(): {
	runtime: IAgentRuntime;
	observed: Promise<Record<string, unknown>>;
} {
	let resolveObserved: (payload: Record<string, unknown>) => void = () => {};
	const observed = new Promise<Record<string, unknown>>((resolve) => {
		resolveObserved = resolve;
	});
	const runtime = {
		emitEvent: async (type: unknown, payload: Record<string, unknown>) => {
			if (type === EventType.VOICE_TURN_OBSERVED) resolveObserved(payload);
		},
	} as unknown as IAgentRuntime;
	return { runtime, observed };
}

/**
 * Build a minimal bridge, then inject the attribution + pipeline mocks onto its
 * private seams. `buildPipeline` is overridden to a fake pipeline that fires
 * `onAsrComplete` (the in-pipeline transcript source) on `run`.
 */
function bridgeWithJoin(opts: {
	bundleRoot: string;
	runtime: IAgentRuntime;
	asrTokens: ReadonlyArray<{ index: number; text: string }>;
	/** When true, the fake pipeline never fires onAsrComplete (cancelled/no-ASR). */
	skipAsr?: boolean;
	/** Resolve the fake attribution only after this promise (timing control). */
	attributionGate?: Promise<void>;
	attributionEmbedding?: Float32Array;
}): EngineVoiceBridge {
	const bridge = EngineVoiceBridge.start({
		bundleRoot: opts.bundleRoot,
		useFfiBackend: false,
		lifecycleLoaders: lifecycleLoadersOk(),
	});
	const internals = bridge as unknown as {
		attributionPipeline: {
			attribute(req: unknown): Promise<VoiceAttributionOutput>;
		};
		eventRuntime: IAgentRuntime;
		buildPipeline(
			runner: unknown,
			config: unknown,
			events?: {
				onAsrComplete?(
					tokens: ReadonlyArray<{ index: number; text: string }>,
				): void;
			},
		): { run(audio: unknown): Promise<"done">; cancel(): void };
	};
	internals.eventRuntime = opts.runtime;
	internals.attributionPipeline = {
		async attribute() {
			if (opts.attributionGate) await opts.attributionGate;
			return attributionOutput(opts.attributionEmbedding);
		},
	};
	internals.buildPipeline = (_runner, _config, events) => ({
		async run() {
			if (!opts.skipAsr) events?.onAsrComplete?.(opts.asrTokens);
			return "done";
		},
		cancel() {},
	});
	return bridge;
}

const TEXT_RUNNER = {} as MtpTextRunner;
const AUDIO = { pcm: new Float32Array(16_000), sampleRate: 16_000 };
const CONFIG = { maxDraftTokens: 4 };

describe("EngineVoiceBridge runVoiceTurn — transcript join (#8786)", () => {
	let bundleRoot: string;

	beforeEach(() => {
		bundleRoot = mkdtempSync(path.join(tmpdir(), "eliza-transcript-join-"));
		writePresetBundle(bundleRoot);
	});

	afterEach(() => {
		rmSync(bundleRoot, { recursive: true, force: true });
	});

	it("rides the turn's ASR transcript on VOICE_TURN_OBSERVED (not '')", async () => {
		const { runtime, observed } = captureRuntime();
		const bridge = bridgeWithJoin({
			bundleRoot,
			runtime,
			asrTokens: [
				{ index: 0, text: "I'm " },
				{ index: 1, text: "Jill" },
			],
		});
		await bridge.arm();

		await bridge.runVoiceTurn(AUDIO, TEXT_RUNNER, CONFIG);
		const payload = await observed;

		// The whole point of #8786: the merge engine needs the words, not just
		// the speaker.
		expect(payload.text).toBe("I'm Jill");
	});

	it("joins even when attribution resolves before ASR completes", async () => {
		// Force the attribution to resolve first; the `.then` must still await the
		// transcript (resolved later, inside the pipeline run) rather than emit "".
		let openGate: () => void = () => {};
		const attributionGate = new Promise<void>((r) => {
			openGate = r;
		});
		const { runtime, observed } = captureRuntime();
		const bridge = bridgeWithJoin({
			bundleRoot,
			runtime,
			asrTokens: [{ index: 0, text: "hello there" }],
			attributionGate,
		});
		await bridge.arm();
		// Let attribution resolve immediately on the next microtask.
		openGate();

		await bridge.runVoiceTurn(AUDIO, TEXT_RUNNER, CONFIG);
		const payload = await observed;
		expect(payload.text).toBe("hello there");
	});

	it("emits with text='' for a turn whose ASR never completes (no hang)", async () => {
		const { runtime, observed } = captureRuntime();
		const bridge = bridgeWithJoin({
			bundleRoot,
			runtime,
			asrTokens: [{ index: 0, text: "unused" }],
			skipAsr: true,
		});
		await bridge.arm();

		await bridge.runVoiceTurn(AUDIO, TEXT_RUNNER, CONFIG);
		// The pipeline `finally` settles the transcript promise, so attribution
		// resolves (with "") rather than hanging the await forever.
		const payload = await observed;
		expect(payload.text).toBe("");
	});

	it("folds live self-voice similarity into the emitted turn signal", async () => {
		const { runtime, observed } = captureRuntime();
		const attributionEmbedding = unitEmbedding();
		const bridge = bridgeWithJoin({
			bundleRoot,
			runtime,
			asrTokens: [{ index: 0, text: "hey eliza" }],
			attributionEmbedding,
		});
		const internals = bridge as unknown as {
			scheduler: { bargeIn: { setAgentSpeaking(speaking: boolean): void } };
			selfVoiceImprint: {
				similarity(embedding: Float32Array): Promise<number | null>;
			};
		};
		internals.scheduler.bargeIn.setAgentSpeaking(true);
		internals.selfVoiceImprint = {
			async similarity(embedding) {
				expect(embedding).toBe(attributionEmbedding);
				return 0.91;
			},
		};
		let resolveAttribution: (output: VoiceAttributionOutput) => void = () => {};
		const attributed = new Promise<VoiceAttributionOutput>((resolve) => {
			resolveAttribution = resolve;
		});
		await bridge.arm();

		await bridge.runVoiceTurn(AUDIO, TEXT_RUNNER, CONFIG, {
			onAttribution(output) {
				resolveAttribution(output);
			},
		});
		await observed;
		const attributedOutput = await attributed;

		const signal = attributedOutput.turn.metadata.voiceTurnSignal as
			| {
					agentShouldSpeak: boolean | null;
					nextSpeaker: string;
					metadata?: { provenance?: string; selfVoiceSimilarity?: number };
			  }
			| undefined;
		expect(signal?.agentShouldSpeak).toBe(false);
		expect(signal?.nextSpeaker).toBe("user");
		expect(signal?.metadata?.provenance).toBe("voice-bridge+self-voice");
		expect(signal?.metadata?.selfVoiceSimilarity).toBeCloseTo(0.91);
	});
});
