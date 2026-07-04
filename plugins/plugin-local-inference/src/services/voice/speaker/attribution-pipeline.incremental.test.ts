/**
 * Windowed long-turn attribution tests (#12257). Real VoiceProfileStore on a
 * temp dir + a fake encoder/diarizer so the windowing, the shared-tail parity
 * with one-shot `attribute`, the post-endpoint decode bound, and the
 * speech-start speculative `beginMatch` are all exercised against the real
 * profile store — only the native GGUF forward passes are faked.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { VoiceProfileStore } from "../profile-store";
import { VoiceAttributionPipeline } from "./attribution-pipeline";
import type { Diarizer } from "./diarizer";
import { PYANNOTE_SEGMENTATION_3_INT8_MODEL_ID } from "./diarizer";
import type { SpeakerEncoder } from "./encoder";

const SR = 16_000;
const MODEL = "wespeaker-resnet34-lm-int8";
const WINDOW_SAMPLES = 5 * SR;

const stores: VoiceProfileStore[] = [];
async function freshStore(): Promise<VoiceProfileStore> {
	const dir = mkdtempSync(path.join(tmpdir(), "vp-incr-"));
	const store = new VoiceProfileStore({ rootDir: dir });
	await store.init();
	stores.push(store);
	return store;
}

/** Fixed 256-d embedding — every splice maps to the same speaker. */
function fixedEmbedding(): Float32Array {
	const v = new Float32Array(256);
	for (let i = 0; i < v.length; i += 1) v[i] = Math.sin(i * 0.05);
	return v;
}

function makeEncoder(): SpeakerEncoder & { inputs: number[] } {
	return {
		embeddingDim: 256,
		sampleRate: SR,
		modelId: MODEL,
		inputs: [],
		async encode(pcm) {
			this.inputs.push(pcm.length);
			return fixedEmbedding();
		},
		async dispose() {},
	};
}

/** One full-window single-speaker segment per decode; records input lengths. */
function makeDiarizer(): Diarizer & { inputs: number[] } {
	return {
		modelId: PYANNOTE_SEGMENTATION_3_INT8_MODEL_ID,
		sampleRate: SR,
		inputs: [],
		async diarizeWindow(pcm) {
			this.inputs.push(pcm.length);
			const durationMs = Math.round((pcm.length / SR) * 1000);
			return {
				localSpeakerCount: 1,
				speechMs: durationMs,
				segments: [
					{
						startMs: 0,
						endMs: durationMs,
						localSpeakerId: 0,
						confidence: 0.9,
						hasOverlap: false,
					},
				],
			};
		},
		async dispose() {},
	};
}

afterEach(() => {
	stores.length = 0;
});

describe("VoiceAttributionPipeline windowed long turns", () => {
	it("post-endpoint decode is bounded to one trailing window, not the whole turn", async () => {
		const encoder = makeEncoder();
		const diarizer = makeDiarizer();
		const pipeline = new VoiceAttributionPipeline({
			encoder,
			diarizer,
			profileStore: await freshStore(),
		});

		const attributor = pipeline.beginTurn({ turnId: "t-long", startedAtMs: 0 });
		// Two full 5 s windows decode DURING the turn.
		await attributor.pushWindow(new Float32Array(WINDOW_SAMPLES), 0);
		await attributor.pushWindow(new Float32Array(WINDOW_SAMPLES), 5_000);
		expect(attributor.windowsDiarized).toBe(2);

		// Speech-end: only the trailing 4 s partial window is left to decode.
		const finalWindow = new Float32Array(4 * SR);
		const fullPcm = new Float32Array(14 * SR);
		const output = await attributor.finalize({
			fullPcm,
			finalWindowPcm: finalWindow,
			finalWindowStartMs: 10_000,
			endedAtMs: 14_000,
		});

		// Three diarizer decodes total: window0, window1 (both during capture),
		// and the trailing 4 s partial at finalize — never the 14 s whole turn.
		expect(diarizer.inputs).toEqual([WINDOW_SAMPLES, WINDOW_SAMPLES, 4 * SR]);
		expect(diarizer.inputs[diarizer.inputs.length - 1]).toBeLessThanOrEqual(
			WINDOW_SAMPLES,
		);
		expect(output.primarySpeaker).toBeDefined();
		expect(output.observation).not.toBeNull();
	});

	it("merged windowed spans cover the whole turn identically to one-shot", async () => {
		const turnMs = 14_000;
		const fullPcm = new Float32Array(14 * SR);

		// One-shot: whole 14 s decoded in a single call.
		const oneShotDia = makeDiarizer();
		const oneShot = new VoiceAttributionPipeline({
			encoder: makeEncoder(),
			diarizer: oneShotDia,
			profileStore: await freshStore(),
		});
		const oneShotOut = await oneShot.attribute({
			turnId: "t1",
			pcm: fullPcm,
			startedAtMs: 0,
			endedAtMs: turnMs,
		});
		expect(oneShotDia.inputs).toEqual([14 * SR]);

		// Incremental: same turn, windowed.
		const incrDia = makeDiarizer();
		const incremental = new VoiceAttributionPipeline({
			encoder: makeEncoder(),
			diarizer: incrDia,
			profileStore: await freshStore(),
		});
		const attributor = incremental.beginTurn({ turnId: "t2", startedAtMs: 0 });
		await attributor.pushWindow(new Float32Array(WINDOW_SAMPLES), 0);
		await attributor.pushWindow(new Float32Array(WINDOW_SAMPLES), 5_000);
		const incrOut = await attributor.finalize({
			fullPcm,
			finalWindowPcm: new Float32Array(4 * SR),
			finalWindowStartMs: 10_000,
			endedAtMs: turnMs,
		});

		// Same primary-speaker span coverage — the merged windows reconstruct the
		// whole turn, so the embedding/profile-match sees the same audio window
		// (the profile cluster ids differ only because each ran on a fresh store).
		expect(oneShotOut.observation?.startMs).toBe(0);
		expect(oneShotOut.observation?.endMs).toBe(turnMs);
		expect(incrOut.observation?.startMs).toBe(0);
		expect(incrOut.observation?.endMs).toBe(turnMs);
		expect(oneShotOut.primarySpeaker).toBeDefined();
		expect(incrOut.primarySpeaker).toBeDefined();
		expect(incrOut.observation?.embedding).toEqual(
			oneShotOut.observation?.embedding,
		);
	});

	it("resolves the speech-start speculative match before the turn finalizes", async () => {
		const store = await freshStore();
		// Enroll the speaker first so the speculative lookup hits.
		const enrolled = await store.createProfile({
			centroid: fixedEmbedding(),
			embeddingModel: MODEL,
			entityId: null,
			confidence: 0.9,
			durationMs: 2_000,
		});
		const pipeline = new VoiceAttributionPipeline({
			encoder: makeEncoder(),
			diarizer: makeDiarizer(),
			profileStore: store,
		});

		const attributor = pipeline.beginTurn({ turnId: "t-spec", startedAtMs: 0 });
		// First window fills → speculative encode + findBestMatch fire.
		await attributor.pushWindow(new Float32Array(WINDOW_SAMPLES), 0);
		const speculative = await attributor.speculativeMatch.result;
		expect(speculative?.profile.id).toBe(enrolled.profileId);

		// finalize still completes normally afterward.
		const out = await attributor.finalize({
			fullPcm: new Float32Array(WINDOW_SAMPLES),
			endedAtMs: 5_000,
		});
		expect(out.primarySpeaker?.entityId).toBeUndefined();
		expect(out.observation?.profileId).toBe(enrolled.profileId);
	});

	it("a sub-window turn finalizes over the single whole-turn window (short-turn parity)", async () => {
		const diarizer = makeDiarizer();
		const pipeline = new VoiceAttributionPipeline({
			encoder: makeEncoder(),
			diarizer,
			profileStore: await freshStore(),
		});
		const attributor = pipeline.beginTurn({
			turnId: "t-short",
			startedAtMs: 0,
		});
		// No window ever filled during a 1.5 s turn.
		expect(attributor.windowsDiarized).toBe(0);
		const shortPcm = new Float32Array(Math.round(1.5 * SR));
		const out = await attributor.finalize({
			fullPcm: shortPcm,
			finalWindowPcm: shortPcm,
			finalWindowStartMs: 0,
			endedAtMs: 1_500,
		});
		// Exactly one diarizer decode — the whole (sub-window) turn.
		expect(diarizer.inputs).toEqual([shortPcm.length]);
		expect(out.observation).not.toBeNull();
	});
});
