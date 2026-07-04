/**
 * Regression test for the fused-EOT voice-budget leak on a failed voice arm
 * (#12895). `LocalInferenceEngine.startVoiceSession()` reserves the 8 MB
 * fused-EOT scoring context via `tryBuildFusedEotClassifier`, but only wires
 * its release into `controller.stop` at the very end of the arm. Any await in
 * between (ASR-unavailable, turn-detector warm, wake/mic startup) that throws
 * would leak the reservation against the process-wide budget. This drives the
 * REAL `startVoiceSession` arm path with a minimal fake bridge + injected test
 * budget, forces `createStreamingTranscriber` to throw after the reservation is
 * taken, and asserts the budget returns to baseline. Deterministic — no native
 * library, no mic, no audio.
 */

import { afterEach, describe, expect, it } from "vitest";
import { classifyDeviceTier } from "../device-tier";
import { LocalInferenceEngine } from "../engine";
import type { HardwareProbe } from "../types";
import type { ElizaInferenceFfi } from "./ffi-bindings";
import { AsrUnavailableError } from "./transcriber";
import type { MicSource } from "./types";
import type { VadDetector } from "./vad";
import {
	createVoiceBudgetForTest,
	setSharedVoiceBudgetForTest,
	type VoiceBudget,
} from "./voice-budget";

const MB = 1024 * 1024;

const maxProbe: HardwareProbe = {
	totalRamGb: 64,
	freeRamGb: 48,
	gpu: { backend: "cuda", totalVramGb: 24, freeVramGb: 22 },
	cpuCores: 16,
	platform: "linux",
	arch: "x64",
	appleSilicon: false,
	recommendedBucket: "xl",
	source: "capacitor-llama",
};

/** Fused FFI stub that advertises the v11 EOT symbol so the fused-EOT
 *  classifier builds and takes its reservation. */
function eotCapableFfi(): ElizaInferenceFfi {
	return {
		libraryPath: "/tmp/fake",
		libraryAbiVersion: "11",
		create: () => 1n,
		destroy: () => {},
		mmapAcquire: () => {},
		mmapEvict: () => {},
		ttsSynthesize: () => {
			throw new Error("not used");
		},
		asrTranscribe: () => {
			throw new Error("not used");
		},
		ttsStreamSupported: () => false,
		ttsSynthesizeStream: () => {
			throw new Error("not used");
		},
		cancelTts: () => {},
		setVerifierCallback: () => ({ close: () => {} }),
		vadSupported: () => true,
		vadOpen: () => 7n,
		vadProcess: () => 0.1,
		vadReset: () => {},
		vadClose: () => {},
		asrStreamSupported: () => false,
		asrStreamOpen: () => {
			throw new Error("not used");
		},
		asrStreamFeed: () => {},
		asrStreamPartial: () => ({ partial: "" }),
		asrStreamFinish: () => ({ partial: "" }),
		asrStreamClose: () => {},
		eotSupported: () => true,
		eotScore: () => ({ targetProb: 0.5 }),
		tokenize: () => new Int32Array([1]),
		close: () => {},
	} as unknown as ElizaInferenceFfi;
}

/** A do-nothing VAD passed via `opts.vad` so the arm skips the native VAD
 *  loader — the fused-EOT reservation still happens before it. */
function fakeVad(): VadDetector {
	return {
		endHangoverMs: 500,
		pushFrame: async () => {},
	} as unknown as VadDetector;
}

/** A mic source that never starts frames — the arm throws (in ASR) before it
 *  is ever used. */
function fakeMicSource(): MicSource {
	return {
		sampleRate: 16_000,
		frameSamples: 512,
		running: false,
		start: async () => {},
		stop: async () => {},
		onFrame: () => () => {},
		onError: () => () => {},
	};
}

/**
 * Minimal structural bridge exposing only the members `startVoiceSession`
 * reads before ASR throws: `lifecycle.current()`, `backend`, `ffi`, and
 * `createStreamingTranscriber()`. `asrThrows` forces the ASR path — the sole
 * failure injected after the fused-EOT reservation is taken.
 */
function fakeBridge(ffi: ElizaInferenceFfi): object {
	return {
		lifecycle: { current: () => ({ kind: "voice-on" }) },
		backend: { id: "ffi" },
		ffi,
		ffiCtx: 1n,
		scheduler: {},
		bundlePath: () => "/tmp/fake-bundle",
		createStreamingTranscriber: () => {
			throw new AsrUnavailableError(
				"[voice] Fused ASR decoder unavailable in this build.",
			);
		},
		bindBargeInControllerForRoom: () => () => {},
		cancellationCoordinatorOrNull: () => null,
	};
}

/** Inject a fake voice bridge into the engine's private field (test seam). */
function injectBridge(engine: LocalInferenceEngine, bridge: object): void {
	(engine as unknown as { voiceBridge: object }).voiceBridge = bridge;
}

describe("startVoiceSession fused-EOT reservation on a failed arm (#12895)", () => {
	afterEach(() => {
		setSharedVoiceBudgetForTest(null);
	});

	function pinBudget(): VoiceBudget {
		const budget = createVoiceBudgetForTest({
			totalBytes: 64 * MB,
			assessment: classifyDeviceTier(maxProbe),
		});
		setSharedVoiceBudgetForTest(budget);
		return budget;
	}

	it("releases the fused-EOT reservation when ASR is unavailable mid-arm", async () => {
		const budget = pinBudget();
		expect(budget.snapshot()).toHaveLength(0);

		const engine = new LocalInferenceEngine();
		injectBridge(engine, fakeBridge(eotCapableFfi()));

		await expect(
			engine.startVoiceSession({
				roomId: "room-1",
				vad: fakeVad(),
				micSource: fakeMicSource(),
				generate: async () => ({ replyText: "" }) as never,
			}),
		).rejects.toBeInstanceOf(AsrUnavailableError);

		// The 8 MB fused-EOT reservation must be released on the throwing path —
		// the budget returns to baseline, no leak.
		expect(budget.snapshot()).toHaveLength(0);
		expect(budget.freeBytes()).toBe(budget.totalBytes());
	});

	it("takes no reservation and leaves the budget clean when EOT is disabled", async () => {
		const budget = pinBudget();

		const engine = new LocalInferenceEngine();
		injectBridge(engine, fakeBridge(eotCapableFfi()));

		await expect(
			engine.startVoiceSession({
				roomId: "room-2",
				vad: fakeVad(),
				micSource: fakeMicSource(),
				turnDetector: false,
				generate: async () => ({ replyText: "" }) as never,
			}),
		).rejects.toBeInstanceOf(AsrUnavailableError);

		expect(budget.snapshot()).toHaveLength(0);
	});
});
