/**
 * Wake-word tests — openWakeWord streaming detector.
 *
 *   - `OpenWakeWordDetector`: refractory debounce + threshold gating,
 *     driven by a deterministic scripted `WakeWordModel`.
 *   - `resolveWakeWordModel`: returns null when the bundle has no
 *     `wake/openwakeword.gguf` (optional asset).
 *   - `GgmlWakeWordModel`: routes through the `eliza_inference_wakeword_*`
 *     FFI surface, surfaces a structured `runtime-not-ready` error when
 *     the fused build does not export the wake-word symbols (the only
 *     supported "no wake-word backend" path — there is no ONNX
 *     fallback, see AGENTS.md §3, §8).
 *
 * The real on-device pipeline is covered by an integration test in the
 * fused-build's test suite (one that actually mmaps a bundled
 * `openwakeword.gguf` and runs frames through it). That test cannot run
 * in this package without the native library, so the unit suite here
 * mocks `ElizaInferenceFfi` and asserts the bindings drive the FFI as
 * advertised.
 */

import { describe, expect, it, vi } from "vitest";
import type {
	ElizaInferenceContextHandle,
	ElizaInferenceFfi,
	NativeWakeWordHandle,
} from "./ffi-bindings";
import {
	GgmlWakeWordModel,
	OpenWakeWordDetector,
	resolveWakeWordModel,
	type WakeWordModel,
	WakeWordUnavailableError,
} from "./wake-word";

const FRAME = 1280; // 80 ms @ 16 kHz — what openWakeWord consumes per step.

// --- Deterministic scripted model -----------------------------------------

class ScriptedWakeWordModel implements WakeWordModel {
	readonly frameSamples = FRAME;
	readonly sampleRate = 16_000;
	private idx = 0;
	resets = 0;
	scored = 0;
	constructor(private readonly probs: readonly number[]) {}
	async scoreFrame(frame: Float32Array): Promise<number> {
		expect(frame.length).toBe(FRAME);
		this.scored++;
		const p = this.probs[this.idx] ?? this.probs[this.probs.length - 1] ?? 0;
		this.idx++;
		return p;
	}
	reset(): void {
		this.resets++;
		this.idx = 0;
	}
}

function zeroFrame(): Float32Array {
	return new Float32Array(FRAME);
}

describe("OpenWakeWordDetector", () => {
	it("fires onWake once when probability crosses the threshold", async () => {
		const model = new ScriptedWakeWordModel([0.1, 0.2, 0.9, 0.95, 0.1]);
		let fired = 0;
		const det = new OpenWakeWordDetector({
			model,
			config: { threshold: 0.5, refractoryFrames: 10 },
			onWake: () => fired++,
		});
		const hits: boolean[] = [];
		for (let i = 0; i < 5; i++) hits.push(await det.pushFrame(zeroFrame()));
		expect(fired).toBe(1);
		expect(hits).toEqual([false, false, true, false, false]);
		// Scored every frame, including during the refractory window.
		expect(model.scored).toBe(5);
	});

	it("debounces a sustained detection during the refractory window", async () => {
		const model = new ScriptedWakeWordModel([0.9, 0.9, 0.9, 0.9, 0.9]);
		let fired = 0;
		const det = new OpenWakeWordDetector({
			model,
			config: { threshold: 0.5, refractoryFrames: 25 },
			onWake: () => fired++,
		});
		for (let i = 0; i < 5; i++) await det.pushFrame(zeroFrame());
		expect(fired).toBe(1); // fire@0, then 4 frames all inside the 25-frame refractory window
	});

	it("re-arms after the refractory window elapses", async () => {
		const model = new ScriptedWakeWordModel([0.9, 0.1, 0.1, 0.9]);
		let fired = 0;
		const det = new OpenWakeWordDetector({
			model,
			config: { threshold: 0.5, refractoryFrames: 2 },
			onWake: () => fired++,
		});
		for (let i = 0; i < 4; i++) await det.pushFrame(zeroFrame());
		expect(fired).toBe(2); // fire@0, cooldown 2 → frames 1,2 silent, fire@3
	});

	it("rejects a wrong-length frame", async () => {
		const det = new OpenWakeWordDetector({
			model: new ScriptedWakeWordModel([0.1]),
			onWake: () => {},
		});
		await expect(det.pushFrame(new Float32Array(640))).rejects.toThrow(/1280/);
	});

	it("reset() clears the cooldown and the model state", async () => {
		const model = new ScriptedWakeWordModel([0.9, 0.9]);
		let fired = 0;
		const det = new OpenWakeWordDetector({
			model,
			config: { threshold: 0.5, refractoryFrames: 50 },
			onWake: () => fired++,
		});
		await det.pushFrame(zeroFrame()); // fires, long cooldown
		expect(fired).toBe(1);
		det.reset();
		expect(model.resets).toBe(1);
		await det.pushFrame(zeroFrame()); // cooldown cleared → fires again
		expect(fired).toBe(2);
	});
});

describe("resolveWakeWordModel", () => {
	it("returns null when the bundle has no wake-word GGUF (optional asset)", () => {
		expect(
			resolveWakeWordModel({ bundleRoot: "/nonexistent/bundle" }),
		).toBeNull();
	});
});

// --- Native FFI routing ---------------------------------------------------

/**
 * Build a minimal `ElizaInferenceFfi` stand-in that exercises the
 * wake-word path. `supported` flips the capability probe; the other
 * methods are spies so the test can assert call shape.
 */
function makeMockFfi(supported: boolean): ElizaInferenceFfi {
	const handle: NativeWakeWordHandle = 0xdeadbeefn;
	const open = vi.fn(() => handle);
	const score = vi.fn(() => 0.42);
	const reset = vi.fn(() => undefined);
	const close = vi.fn(() => undefined);
	const ctx: ElizaInferenceContextHandle = 0xcafef00dn;
	return {
		libraryPath: "/dev/null",
		libraryAbiVersion: "5",
		create: () => ctx,
		destroy: () => {},
		mmapAcquire: () => {},
		mmapEvict: () => {},
		ttsSynthesize: () => 0,
		asrTranscribe: () => "",
		ttsStreamSupported: () => false,
		ttsSynthesizeStream: () => ({ cancelled: false }),
		cancelTts: () => {},
		setVerifierCallback: () => ({ close() {} }),
		asrStreamSupported: () => false,
		asrStreamOpen: () => 0n,
		asrStreamFeed: () => {},
		asrStreamPartial: () => ({ partial: "" }),
		asrStreamFinish: () => ({ partial: "" }),
		asrStreamClose: () => {},
		wakewordSupported: () => supported,
		wakewordOpen: supported ? open : undefined,
		wakewordScore: supported ? score : undefined,
		wakewordReset: supported ? reset : undefined,
		wakewordClose: supported ? close : undefined,
		close: () => {},
	};
}

describe("GgmlWakeWordModel", () => {
	it("throws runtime-not-ready when the FFI does not export wake-word", async () => {
		const ffi = makeMockFfi(false);
		const ctx: ElizaInferenceContextHandle = 0xcafef00dn;
		await expect(
			GgmlWakeWordModel.load({ ffi, ctx, headName: "hey-eliza" }),
		).rejects.toMatchObject({
			name: "WakeWordUnavailableError",
			code: "runtime-not-ready",
		});
	});

	it("isSupported() reflects the FFI capability probe", () => {
		expect(GgmlWakeWordModel.isSupported(null)).toBe(false);
		expect(GgmlWakeWordModel.isSupported(makeMockFfi(false))).toBe(false);
		expect(GgmlWakeWordModel.isSupported(makeMockFfi(true))).toBe(true);
	});

	it("routes scoreFrame through the FFI and surfaces the probability", async () => {
		const ffi = makeMockFfi(true);
		const ctx: ElizaInferenceContextHandle = 0xcafef00dn;
		const model = await GgmlWakeWordModel.load({
			ffi,
			ctx,
			headName: "hey-eliza",
		});
		const p = await model.scoreFrame(new Float32Array(FRAME));
		expect(p).toBe(0.42);
		expect(ffi.wakewordScore).toHaveBeenCalledTimes(1);
	});

	it("rejects a wrong-length frame", async () => {
		const ffi = makeMockFfi(true);
		const ctx: ElizaInferenceContextHandle = 0xcafef00dn;
		const model = await GgmlWakeWordModel.load({
			ffi,
			ctx,
			headName: "hey-eliza",
		});
		await expect(model.scoreFrame(new Float32Array(FRAME - 1))).rejects.toThrow(
			/1280/,
		);
	});

	it("reset() and close() drive the matching FFI symbols", async () => {
		const ffi = makeMockFfi(true);
		const ctx: ElizaInferenceContextHandle = 0xcafef00dn;
		const model = await GgmlWakeWordModel.load({
			ffi,
			ctx,
			headName: "hey-eliza",
		});
		model.reset();
		expect(ffi.wakewordReset).toHaveBeenCalledTimes(1);
		model.close();
		expect(ffi.wakewordClose).toHaveBeenCalledTimes(1);
		// Idempotent — calling close again is a no-op (no extra FFI call).
		model.close();
		expect(ffi.wakewordClose).toHaveBeenCalledTimes(1);
	});

	it("wraps a head-bind failure as WakeWordUnavailableError(model-load-failed)", async () => {
		const ffi = makeMockFfi(true);
		(
			ffi.wakewordOpen as unknown as ReturnType<typeof vi.fn>
		).mockImplementation(() => {
			throw new Error("[ffi-bindings] unknown head 'banana'");
		});
		const ctx: ElizaInferenceContextHandle = 0xcafef00dn;
		await expect(
			GgmlWakeWordModel.load({ ffi, ctx, headName: "banana" }),
		).rejects.toMatchObject({
			name: "WakeWordUnavailableError",
			code: "model-load-failed",
		});
	});
});

// Suppress unused-import lints when WakeWordUnavailableError isn't directly referenced.
void WakeWordUnavailableError;
