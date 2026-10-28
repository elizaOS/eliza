/**
 * Real desktop Paradee-8M v1.1 TTS: the agent voice bridge (`paradeeOnly`)
 * over the host TTS worker on the real fused `libelizainference` and the
 * pinned Paradee GGUF + misaki lexicon. Nothing is mocked: the worker verifies
 * the library digest and model pins, the scheduler chunks and streams the
 * speech, and barge-in reaches the native `eliza_inference_cancel_tts`.
 *
 * Skipped (never faked) unless discovery resolves Paradee: set
 * `ELIZA_PARADEE_MODEL_DIR` (or stage `<stateDir>/local-inference/models/
 * paradee`), `ELIZA_INFERENCE_LIBRARY` and `ELIZA_INFERENCE_LIBRARY_SHA256`
 * (or stage the library with `stage-desktop-fused-lib.ts`). Runs under Bun:
 * the worker needs `bun:ffi`.
 */

import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { EngineVoiceBridge } from "../../engine-bridge";
import type { TtsPcmChunk } from "../../types";
import { createParadeeTtsBackend, wavToFloat32 } from "../paradee-backend";
import { discoverParadeeEngine } from "../paradee-engine-discovery";

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const found = discoverParadeeEngine();
const WORKER = fileURLToPath(
	new URL("../../../../host-tts-worker.ts", import.meta.url),
);

describe.skipIf(!isBun || !found.ok)(
	"desktop Paradee v1.1 TTS through the host worker (real)",
	() => {
		const config = found.ok ? found.config : (null as never);
		const backend = createParadeeTtsBackend(config, { workerPath: WORKER });
		const bridge = EngineVoiceBridge.start({
			bundleRoot: "",
			useFfiBackend: false,
			paradeeOnly: config,
			ttsBackendOverride: backend,
		});
		afterAll(() => bridge.dispose());

		it("synthesizes speech through the voice bridge and reports its real-time factor", async () => {
			await bridge.arm();
			const cold = performance.now();
			await backend.warmUp();
			const loadMs = performance.now() - cold;
			const text =
				"Good morning. Your pharmacy called to say the prescription is ready, and the bus to the clinic leaves at ten.";
			const started = performance.now();
			const wav = await bridge.synthesizeTextToWav(text);
			const elapsedMs = performance.now() - started;
			const { pcm, sampleRate } = wavToFloat32(Buffer.from(wav));
			expect(sampleRate).toBe(24_000);
			const audioMs = (pcm.length / sampleRate) * 1000;
			expect(audioMs).toBeGreaterThan(3000);
			let peak = 0;
			for (const v of pcm) peak = Math.max(peak, Math.abs(v));
			expect(peak).toBeGreaterThan(0.05);
			const rtf = elapsedMs / audioMs;
			console.info(
				`[paradee-real] load=${loadMs.toFixed(0)}ms synth=${elapsedMs.toFixed(0)}ms audio=${audioMs.toFixed(0)}ms RTF=${rtf.toFixed(3)}`,
			);
			expect(rtf).toBeLessThan(1);
		}, 120_000);

		it("reclaims native model memory on disarm and speaks again after rearm", async () => {
			expect(backend.residentModelMb).toBeGreaterThan(0);
			await bridge.disarm();
			expect(backend.residentModelMb).toBe(0);
			await bridge.arm();
			expect(backend.residentModelMb).toBeGreaterThan(0);
			const wav = await bridge.synthesizeTextToWav(
				"Speech works after memory reclamation.",
			);
			expect(wavToFloat32(Buffer.from(wav)).pcm.length).toBeGreaterThan(0);
		}, 120_000);

		it("streams first audio and stops on barge-in", async () => {
			const cancelSignal = { cancelled: false };
			const chunks: TtsPcmChunk[] = [];
			const started = performance.now();
			let firstAudioMs = 0;
			const result = await backend.synthesizeStream({
				phrase: {
					id: 7,
					text: "This reply is long enough that the listener will interrupt it before the end of the sentence arrives.",
					fromIndex: 0,
					toIndex: 0,
					terminator: "punctuation",
				},
				preset: {
					voiceId: "paradee",
					embedding: new Float32Array(0),
					bytes: new Uint8Array(0),
				},
				cancelSignal,
				onChunk: (chunk) => {
					chunks.push(chunk);
					if (!chunk.isFinal && !firstAudioMs) {
						firstAudioMs = performance.now() - started;
						cancelSignal.cancelled = true;
					}
					return false;
				},
			});
			expect(result.cancelled).toBe(true);
			expect(chunks.filter((c) => !c.isFinal)).toHaveLength(1);
			expect(chunks.at(-1)?.isFinal).toBe(true);
			console.info(`[paradee-real] firstAudio=${firstAudioMs.toFixed(0)}ms`);
		}, 120_000);

		it("cancels a synthesis in flight natively", async () => {
			const cancelSignal = { cancelled: false };
			setTimeout(() => {
				cancelSignal.cancelled = true;
			}, 20);
			const started = performance.now();
			const result = await backend.synthesizeStream({
				phrase: {
					id: 8,
					text: "word ".repeat(80).trim(),
					fromIndex: 0,
					toIndex: 0,
					terminator: "max-cap",
				},
				preset: {
					voiceId: "paradee",
					embedding: new Float32Array(0),
					bytes: new Uint8Array(0),
				},
				cancelSignal,
				onChunk: () => false,
			});
			expect(result.cancelled).toBe(true);
			console.info(
				`[paradee-real] cancel settled in ${(performance.now() - started).toFixed(0)}ms`,
			);
			// The worker stays usable after a cancel.
			const wav = await bridge.synthesizeTextToWav("Still here.");
			expect(wavToFloat32(Buffer.from(wav)).pcm.length).toBeGreaterThan(0);
		}, 120_000);
	},
);
