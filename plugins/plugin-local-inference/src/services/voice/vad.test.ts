/**
 * VAD tests — the two-tier audio gate.
 *
 *   - `RmsEnergyGate`: hysteresis on synthetic sine / silence frames.
 *   - `VadDetector`: speech state machine driven by a *deterministic fake
 *     Silero* (probability scripted per window), asserting the full
 *     `VadEvent` sequence (start → active → pause → end / blip).
 *   - `GgmlSileroVad`: the fused libelizainference VAD — the sole on-device
 *     VAD runtime. Exercised here via the fake FFI fixture; provider
 *     resolution and fail-fast paths are covered below.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { fakeFfi } from "./__test-helpers__/fake-ffi";
import type { PcmFrame, VadEvent } from "./types";
import {
	createSileroVadDetector,
	createVadDetector,
	GgmlSileroVad,
	NativeSileroVad,
	RmsEnergyGate,
	resolveVadProvider,
	rms,
	VadDetector,
	VadUnavailableError,
	vadProviderOrder,
} from "./vad";

const SR = 16_000;
const FRAME = 512; // one Silero window
const FRAME_MS = (FRAME / SR) * 1000; // 32 ms

function silenceFrame(ts: number): PcmFrame {
	return { pcm: new Float32Array(FRAME), sampleRate: SR, timestampMs: ts };
}

function sineFrame(ts: number, amplitude: number, freq = 220): PcmFrame {
	const pcm = new Float32Array(FRAME);
	for (let i = 0; i < FRAME; i++) {
		pcm[i] = amplitude * Math.sin((2 * Math.PI * freq * i) / SR);
	}
	return { pcm, sampleRate: SR, timestampMs: ts };
}

// --- Deterministic fake Silero --------------------------------------------

class ScriptedSilero {
	readonly sampleRate = SR;
	readonly windowSamples = FRAME;
	private idx = 0;
	resets = 0;
	constructor(private readonly probs: readonly number[]) {}
	async process(window: Float32Array): Promise<number> {
		expect(window.length).toBe(FRAME);
		const p = this.probs[this.idx] ?? this.probs[this.probs.length - 1] ?? 0;
		this.idx++;
		return p;
	}
	/** Real Silero clears its LSTM state here; it does NOT rewind the input
	 *  stream — so the scripted probability cursor stays where it is. */
	reset(): void {
		this.resets++;
	}
}

class DeferredSilero {
	readonly sampleRate = SR;
	readonly windowSamples = FRAME;
	readonly calls: Float32Array[] = [];
	private readonly resolvers: Array<(prob: number) => void> = [];
	private readonly waiters: Array<{ n: number; resolve: () => void }> = [];

	async process(window: Float32Array): Promise<number> {
		this.calls.push(window.slice());
		this.notify();
		return new Promise<number>((resolve) => {
			this.resolvers.push(resolve);
		});
	}

	reset(): void {}

	resolveNext(prob: number): void {
		const resolve = this.resolvers.shift();
		if (!resolve) throw new Error("no pending Silero process call");
		resolve(prob);
	}

	waitForCalls(n: number): Promise<void> {
		if (this.calls.length >= n) return Promise.resolve();
		return new Promise((resolve) => {
			this.waiters.push({ n, resolve });
		});
	}

	private notify(): void {
		for (let i = this.waiters.length - 1; i >= 0; i--) {
			const waiter = this.waiters[i];
			if (this.calls.length >= waiter.n) {
				this.waiters.splice(i, 1);
				waiter.resolve();
			}
		}
	}
}

async function feedProbs(
	detector: VadDetector,
	probs: readonly number[],
): Promise<VadEvent[]> {
	const events: VadEvent[] = [];
	detector.onVadEvent((e) => events.push(e));
	let ts = 1000;
	for (let i = 0; i < probs.length; i++) {
		await detector.pushFrame(silenceFrame(ts));
		ts += FRAME_MS;
	}
	await detector.flush();
	return events;
}

describe("rms", () => {
	it("is zero for silence and ~amplitude/√2 for a sine", () => {
		expect(rms(new Float32Array(256))).toBe(0);
		const pcm = sineFrame(0, 0.5).pcm;
		expect(rms(pcm)).toBeGreaterThan(0.3);
		expect(rms(pcm)).toBeLessThan(0.4);
	});
});

describe("RmsEnergyGate", () => {
	it("rises above riseThreshold and falls after the hold window", () => {
		const gate = new RmsEnergyGate({ riseThreshold: 0.05, fallHoldMs: 60 });
		const events: string[] = [];
		gate.onEvent((e) => events.push(`${e.type}`));

		let ts = 0;
		// Silence — no event.
		gate.push(silenceFrame(ts));
		ts += FRAME_MS;
		expect(events).toEqual([]);
		expect(gate.isActive).toBe(false);

		// Loud — rise.
		gate.push(sineFrame(ts, 0.3));
		ts += FRAME_MS;
		expect(events).toEqual(["energy-rise"]);
		expect(gate.isActive).toBe(true);

		// Stay loud — no extra rise.
		gate.push(sineFrame(ts, 0.3));
		ts += FRAME_MS;
		expect(events).toEqual(["energy-rise"]);

		// First quiet frame — starts the hold timer; still active.
		gate.push(silenceFrame(ts));
		ts += FRAME_MS;
		expect(gate.isActive).toBe(true);

		// Second quiet frame — 32 ms quiet, still inside the 60 ms window.
		gate.push(silenceFrame(ts));
		ts += FRAME_MS;
		expect(gate.isActive).toBe(true);

		// Third quiet frame — 64 ms quiet, past the hold window → fall.
		gate.push(silenceFrame(ts));
		expect(events).toEqual(["energy-rise", "energy-fall"]);
		expect(gate.isActive).toBe(false);
	});

	it("does not fall when energy returns inside the hold window", () => {
		const gate = new RmsEnergyGate({ riseThreshold: 0.05, fallHoldMs: 200 });
		const events: string[] = [];
		gate.onEvent((e) => events.push(e.type));
		let ts = 0;
		gate.push(sineFrame(ts, 0.3));
		ts += FRAME_MS; // rise
		gate.push(silenceFrame(ts));
		ts += FRAME_MS; // quiet, 32ms < 200ms
		gate.push(sineFrame(ts, 0.3));
		ts += FRAME_MS; // loud again — cancels the fall
		gate.push(silenceFrame(ts));
		ts += FRAME_MS;
		expect(events).toEqual(["energy-rise"]);
	});
});

describe("VadDetector", () => {
	it("emits speech-start → speech-active → speech-pause → speech-end for a clean utterance", async () => {
		// 0..2 silence, 3..13 speech (~350 ms), then long silence to end.
		const probs = [
			0.01, 0.01, 0.01, 0.9, 0.95, 0.9, 0.92, 0.88, 0.9, 0.91, 0.93, 0.9, 0.9,
			0.9, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02,
			0.02, 0.02, 0.02, 0.02, 0.02,
		];
		const det = new VadDetector(new ScriptedSilero(probs), {
			onsetThreshold: 0.5,
			pauseHangoverMs: 100,
			endHangoverMs: 300,
			minSpeechMs: 150,
			activeHeartbeatMs: 64,
		});
		const events = await feedProbs(det, probs);
		const types = events.map((e) => e.type);
		expect(types[0]).toBe("speech-start");
		expect(types).toContain("speech-active");
		expect(types).toContain("speech-pause");
		expect(types[types.length - 1]).toBe("speech-end");
		const end = events.find((e) => e.type === "speech-end");
		expect(
			end && end.type === "speech-end" && end.speechDurationMs,
		).toBeGreaterThan(150);
	});

	it("classifies a too-short burst as a blip, not speech-end", async () => {
		// One speech window only (~32 ms), then silence.
		const probs = [
			0.01, 0.9, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02,
			0.02,
		];
		const det = new VadDetector(new ScriptedSilero(probs), {
			onsetThreshold: 0.5,
			pauseHangoverMs: 64,
			endHangoverMs: 128,
			minSpeechMs: 200,
		});
		const events = await feedProbs(det, probs);
		const types = events.map((e) => e.type);
		expect(types[0]).toBe("speech-start");
		expect(types).toContain("blip");
		expect(types).not.toContain("speech-end");
	});

	it("reopens speech when energy returns during the pause hangover", async () => {
		// speech, brief dip (1 window), speech again, then end — single segment.
		const probs = [
			0.9, 0.9, 0.9, 0.9, 0.9, 0.1, 0.9, 0.9, 0.9, 0.9, 0.9, 0.02, 0.02, 0.02,
			0.02, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02,
		];
		const det = new VadDetector(new ScriptedSilero(probs), {
			onsetThreshold: 0.5,
			pauseHangoverMs: 100, // 3+ windows
			endHangoverMs: 250,
			minSpeechMs: 150,
			activeHeartbeatMs: 1000, // suppress heartbeats so we count starts cleanly
		});
		const events = await feedProbs(det, probs);
		const starts = events.filter((e) => e.type === "speech-start");
		expect(starts).toHaveLength(1); // not a new segment after the dip
		expect(events[events.length - 1].type).toBe("speech-end");
	});

	it("re-windows arbitrarily-sized input frames into 512-sample windows", async () => {
		const probs = [0.9, 0.9, 0.9, 0.9, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02];
		const silero = new ScriptedSilero(probs);
		const det = new VadDetector(silero, {
			onsetThreshold: 0.5,
			pauseHangoverMs: 64,
			endHangoverMs: 128,
			minSpeechMs: 1,
		});
		const events: VadEvent[] = [];
		det.onVadEvent((e) => events.push(e));
		// Feed 1280 samples in one 700-sample chunk + one 580-sample chunk +
		// tail in flush — that's 2.5 windows; flush pads the rest.
		await det.pushFrame({
			pcm: new Float32Array(700),
			sampleRate: SR,
			timestampMs: 0,
		});
		await det.pushFrame({
			pcm: new Float32Array(580),
			sampleRate: SR,
			timestampMs: 50,
		});
		// Tail of zeros to drive the segment to end.
		for (let i = 0; i < 8; i++) {
			await det.pushFrame({
				pcm: new Float32Array(512),
				sampleRate: SR,
				timestampMs: 100 + i * FRAME_MS,
			});
		}
		await det.flush();
		expect(events.some((e) => e.type === "speech-start")).toBe(true);
	});

	it("rejects a sample-rate mismatch", async () => {
		const det = new VadDetector(new ScriptedSilero([0.1]));
		await expect(
			det.pushFrame({
				pcm: new Float32Array(512),
				sampleRate: 8000,
				timestampMs: 0,
			}),
		).rejects.toThrow(/16000/);
	});

	it("serializes pending-buffer mutation per pushFrame call", async () => {
		const silero = new DeferredSilero();
		const det = new VadDetector(silero);
		const p1 = det.pushFrame(sineFrame(0, 0.1));
		const p2 = det.pushFrame(sineFrame(FRAME_MS, 0.1));

		await silero.waitForCalls(1);
		expect(silero.calls).toHaveLength(1);
		silero.resolveNext(0.1);
		const p1SettledBeforeSecondWindowStarts = await Promise.race([
			p1.then(() => true),
			silero.waitForCalls(2).then(() => false),
		]);

		await silero.waitForCalls(2);
		expect(silero.calls).toHaveLength(2);
		silero.resolveNext(0.1);
		await Promise.all([p1, p2]);

		expect(p1SettledBeforeSecondWindowStarts).toBe(true);
		expect(det.droppedFrames).toBe(0);
	});
});

describe("GgmlSileroVad", () => {
	it("documents the auto provider order: optional external VAD adapter → fused native Silero", () => {
		// Fused `silero-ggml` (the one libelizainference handle) is the sole
		// on-device VAD runtime; the optional injected `external-vad` adapter is
		// tried first only when a caller supplies one.
		expect(vadProviderOrder()).toEqual(["external-vad", "silero-ggml"]);
		expect(vadProviderOrder("silero-ggml")).toEqual(["silero-ggml"]);
	});

	it("exposes NativeSileroVad as a back-compat alias for GgmlSileroVad", () => {
		expect(NativeSileroVad).toBe(GgmlSileroVad);
	});

	it("prefers a supplied external VAD adapter over the native provider", async () => {
		const externalVad = new ScriptedSilero([
			0.01, 0.9, 0.9, 0.02, 0.02, 0.02, 0.02, 0.02,
		]);
		const ffi = fakeFfi("x", {
			vadSupported: true,
			vadProbs: [0.01],
		});
		const resolved = await resolveVadProvider({
			externalVad: {
				isAvailable: () => true,
				loadVad: async () => externalVad,
			},
			ffi,
			ctx: 1n,
		});

		expect(resolved.id).toBe("external-vad");
		expect(resolved.vad).toBe(externalVad);

		const det = await createVadDetector({
			externalVad: {
				loadVad: async () => externalVad,
			},
			ffi,
			ctx: 1n,
			config: {
				onsetThreshold: 0.5,
				pauseHangoverMs: 64,
				endHangoverMs: 128,
				minSpeechMs: 1,
			},
		});
		const events = await feedProbs(det, [0, 0, 0, 0, 0, 0, 0, 0]);
		expect(events.some((e) => e.type === "speech-start")).toBe(true);
	});

	it("uses the native FFI path when support is advertised", async () => {
		const ffi = fakeFfi("x", {
			vadSupported: true,
			vadProbs: [0.1, 0.9, 0.02, 0.02, 0.02, 0.02, 0.02, 0.02],
		});
		const native = await GgmlSileroVad.load({ ffi, ctx: 1n });
		expect(native.windowSamples).toBe(FRAME);
		expect(native.sampleRate).toBe(SR);
		expect(await native.process(new Float32Array(FRAME))).toBe(0.1);
		expect(await native.process(new Float32Array(FRAME))).toBe(0.9);
		expect(() => native.reset()).not.toThrow();
		expect(() => native.close()).not.toThrow();
	});

	it("createSileroVadDetector goes through the unified resolver", async () => {
		// The external adapter short-circuits resolution before any
		// FFI / model-file checks run, which exercises the unified resolver
		// end-to-end without needing a libelizainference build.
		const externalVad = new ScriptedSilero([
			0.01, 0.9, 0.9, 0.02, 0.02, 0.02, 0.02, 0.02,
		]);
		const det = await createSileroVadDetector({
			externalVad: {
				loadVad: async () => externalVad,
			},
			config: {
				onsetThreshold: 0.5,
				pauseHangoverMs: 64,
				endHangoverMs: 128,
				minSpeechMs: 1,
			},
		});
		const events = await feedProbs(det, [0, 0, 0, 0, 0, 0, 0, 0]);
		expect(events.some((e) => e.type === "speech-start")).toBe(true);
	});

	it("fails loudly when the libelizainference build does not advertise VAD support", async () => {
		const ffi = fakeFfi("x", { vadSupported: false });
		await expect(
			createSileroVadDetector({
				ffi,
				ctx: 1n,
				modelPath: "/nonexistent/silero.ggml.bin",
			}),
		).rejects.toMatchObject({
			name: "VadUnavailableError",
		});
	});

	it("fails loudly with provider-missing when no FFI and no adapter are supplied", async () => {
		await expect(createSileroVadDetector({})).rejects.toMatchObject({
			name: "VadUnavailableError",
			code: "provider-missing",
		});
	});

	it("fails loudly with model-missing when FFI is ready but the GGML model is absent", async () => {
		const ffi = fakeFfi("x", { vadSupported: true, vadProbs: [0.1] });
		await expect(
			createSileroVadDetector({
				ffi,
				ctx: 1n,
				modelPath: "/nonexistent/silero.ggml.bin",
			}),
		).rejects.toMatchObject({
			name: "VadUnavailableError",
			code: "model-missing",
		});
	});

	it("GgmlSileroVad.load throws VadUnavailableError when ffi.vadSupported returns false", async () => {
		const ffi = fakeFfi("x", { vadSupported: false });
		await expect(GgmlSileroVad.load({ ffi, ctx: 1n })).rejects.toMatchObject({
			name: "VadUnavailableError",
			code: "ffi-missing",
		});
	});

	it("VadUnavailableError code 'ffi-missing' is the canonical signal for an ABI-only libelizainference build", () => {
		const err = new VadUnavailableError("ffi-missing", "no symbols");
		expect(err).toBeInstanceOf(VadUnavailableError);
		expect(err.code).toBe("ffi-missing");
	});

	it("resolves to the fused silero-ggml when the fused FFI advertises VAD and the model is staged", async () => {
		// The fused handle advertises VAD support and the bundle carries the
		// GGML model, so resolution lands on the fused `silero-ggml` — the one
		// libelizainference handle and the sole on-device VAD runtime.
		const dir = mkdtempSync(path.join(os.tmpdir(), "fused-vad-"));
		try {
			const ggml = path.join(dir, "vad", "silero-vad-v5.1.2.ggml.bin");
			mkdirSync(path.dirname(ggml), { recursive: true });
			writeFileSync(ggml, "");
			const ffi = fakeFfi("x", { vadSupported: true, vadProbs: [0.1] });
			const resolved = await resolveVadProvider({
				ffi,
				ctx: 1n,
				bundleRoot: dir,
			});
			expect(resolved.id).toBe("silero-ggml");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("accepts the bundled silero-vad-v5.gguf alias used by published bundles", async () => {
		const dir = mkdtempSync(path.join(os.tmpdir(), "fused-vad-gguf-"));
		try {
			const gguf = path.join(dir, "vad", "silero-vad-v5.gguf");
			mkdirSync(path.dirname(gguf), { recursive: true });
			writeFileSync(gguf, "");
			const ffi = fakeFfi("x", { vadSupported: true, vadProbs: [0.1] });
			const resolved = await resolveVadProvider({
				ffi,
				ctx: 1n,
				bundleRoot: dir,
			});
			expect(resolved.id).toBe("silero-ggml");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
