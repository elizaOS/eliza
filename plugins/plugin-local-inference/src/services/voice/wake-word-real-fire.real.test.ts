/**
 * Real-FFI test for the on-device wake fire that #10351 bridges to the renderer.
 *
 * Drives the ACTUAL standalone `libwakeword` runtime (`bun:ffi` →
 * `OpenWakeWordGgmlModel`) wrapped in the production `OpenWakeWordDetector`
 * (threshold + activation streak + refractory), over a REAL "hey eliza" 16 kHz
 * mono f32 clip, and asserts the detector fires exactly once with a real
 * `confidence` in [0, 1] — the value the engine now forwards to the renderer as
 * `{ stage: "head-fired", confidence }` (the producer half of the
 * `eliza:fused-wake` bridge). A silence-only stream must NOT fire.
 *
 * This is the producer-side proof of the split #10351 e2e: it exercises the real
 * native lib + the real detection loop (no synthetic score, no mock model). The
 * renderer half (emit → bottom bar activates) is proven by the Chromium e2e
 * (`packages/ui/.../__e2e__/run-fused-wake-e2e.mjs`); the cross-process desktop
 * chain by the manual capture under `.github/issue-evidence/10351-fused-wake/`.
 *
 * Skipped (never faked) when:
 *   - not running under Bun (`bun:ffi`), or
 *   - `resolveWakeWordStandalonePaths({ head: "hey-eliza" })` is null — i.e. the
 *     prebuilt `libwakeword.{dylib,so}` and the three `hey-eliza.*.gguf` are not
 *     staged. Stage them with:
 *       cmake -B packages/native/plugins/wakeword-cpp/build \
 *             -S packages/native/plugins/wakeword-cpp && \
 *       cmake --build packages/native/plugins/wakeword-cpp/build -j
 *       # download the 3 fp16 GGUFs (HF elizaos/eliza-1@c544bb4c, voice/wakeword/)
 *       # into packages/native/plugins/wakeword-cpp/build/wakeword/
 * Runs via `bun test` (post-merge `*.real.test.ts` lane; excluded from the
 * default vitest lane). Reference: "hey eliza" peaks ~0.99–1.0, "hey jarvis"
 * ~0.13 (`.github/issue-evidence/9880-wake-word/wakeword-detection.log`).
 */

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	OpenWakeWordDetector,
	resolveWakeWordStandalonePaths,
} from "./wake-word";
import { OpenWakeWordGgmlModel } from "./wake-word-ggml";

const isBun = typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
const PATHS = isBun
	? resolveWakeWordStandalonePaths({ head: "hey-eliza" })
	: null;
const CLIP = fileURLToPath(
	new URL("./__fixtures__/hey-eliza-16k.f32", import.meta.url),
);
const READY = isBun && PATHS !== null && existsSync(CLIP);

/** Read a little-endian f32 PCM file as a Float32Array (16 kHz mono). */
function readF32(file: string): Float32Array {
	const buf = readFileSync(file);
	return new Float32Array(
		buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
	);
}

const FRAME = 1280; // 80 ms @ 16 kHz — the openWakeWord hop the detector expects.

describe.skipIf(!READY)("OpenWakeWordDetector real fire (#10351)", () => {
	it("fires exactly once with a real confidence on a 'hey eliza' clip", async () => {
		const p = PATHS as NonNullable<typeof PATHS>;
		const model = await OpenWakeWordGgmlModel.load({
			libraryPath: p.libraryPath,
			paths: {
				melspec: p.melspec,
				embedding: p.embedding,
				classifier: p.classifier,
			},
			config: { threshold: 0.5 },
		});
		try {
			expect(model.activeBackend()).toContain("native");
			const fires: number[] = [];
			const detector = new OpenWakeWordDetector({
				model,
				onWake: (confidence) => fires.push(confidence),
			});
			const pcm = readF32(CLIP);
			// ~1.9 s of audio is needed before the mel + embedding rings warm up;
			// the vendored clip carries 2.5 s lead-in + phrase + 1 s trailing.
			expect(pcm.length).toBeGreaterThan(16_000 * 2); // > 2 s
			for (let i = 0; i + FRAME <= pcm.length; i += FRAME) {
				await detector.pushFrame(pcm.subarray(i, i + FRAME));
			}
			// Real trained-head fire: exactly one detection (refractory-debounced),
			// at a real high confidence — the value the renderer receives.
			expect(fires).toHaveLength(1);
			expect(fires[0]).toBeGreaterThanOrEqual(0.5);
			expect(fires[0]).toBeLessThanOrEqual(1);
			expect(fires[0]).toBeGreaterThan(0.9); // the eliza-1 head peaks ~0.99–1.0
		} finally {
			model.close();
		}
	});

	it("does not fire on a silence-only stream", async () => {
		const p = PATHS as NonNullable<typeof PATHS>;
		const model = await OpenWakeWordGgmlModel.load({
			libraryPath: p.libraryPath,
			paths: {
				melspec: p.melspec,
				embedding: p.embedding,
				classifier: p.classifier,
			},
			config: { threshold: 0.5 },
		});
		try {
			let fires = 0;
			const detector = new OpenWakeWordDetector({
				model,
				onWake: () => {
					fires += 1;
				},
			});
			const silence = new Float32Array(16_000 * 4); // 4 s of zeros
			for (let i = 0; i + FRAME <= silence.length; i += FRAME) {
				await detector.pushFrame(silence.subarray(i, i + FRAME));
			}
			expect(fires).toBe(0);
		} finally {
			model.close();
		}
	});
});
