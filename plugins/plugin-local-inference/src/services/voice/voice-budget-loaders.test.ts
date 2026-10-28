/**
 * VoiceBudget loader wire-up tests (#12254): every model loader reserves
 * against the allocator before loading and releases on close/dispose/unload.
 * Deterministic — fake FFI bindings, injected test budgets, tmp GGUF files;
 * no native library and no hardware probe.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { BackendPlan } from "../backend";
import { classifyDeviceTier } from "../device-tier";
import {
	type FfiBackendRuntime,
	type FfiBackendSession,
	FfiStreamingBackend,
} from "../ffi-streaming-backend";
import { FfiStreamingRunner } from "../ffi-streaming-runner";
import type { HardwareProbe } from "../types";
import { tryBuildFusedEotClassifier } from "./eot-classifier";
import type {
	ElizaInferenceContextHandle,
	ElizaInferenceFfi,
	ElizaInferenceRegion,
} from "./ffi-bindings";
import { VoiceLifecycleError } from "./lifecycle";
import type { DraftProposer, TargetVerifier } from "./pipeline";
import { VoicePipeline } from "./pipeline";
import { InMemoryAudioSink } from "./ring-buffer";
import { VoiceScheduler } from "./scheduler";
import type {
	SpeakerPreset,
	StreamingTranscriber,
	TranscriptUpdate,
} from "./types";
import { GgmlSileroVad } from "./vad";
import {
	createVoiceBudgetForTest,
	FUSED_EOT_SCORER_RESERVE_BYTES,
	reserveOrRamPressure,
	VAD_RESERVE_BYTES,
	type VoiceBudget,
	WAKE_WORD_RESERVE_BYTES,
} from "./voice-budget";
import { GgmlWakeWordModel, WakeWordUnavailableError } from "./wake-word";

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

function testBudget(totalBytes: number): VoiceBudget {
	return createVoiceBudgetForTest({
		totalBytes,
		assessment: classifyDeviceTier(maxProbe),
	});
}

/** Fake fused FFI with working VAD + wake-word + EOT surfaces. */
function fakeVoiceFfi(
	overrides: Partial<ElizaInferenceFfi> = {},
): ElizaInferenceFfi {
	const base: ElizaInferenceFfi = {
		libraryPath: "/tmp/fake",
		libraryAbiVersion: "11",
		create: (): ElizaInferenceContextHandle => 1n,
		destroy: () => {},
		mmapAcquire: (
			_c: ElizaInferenceContextHandle,
			_r: ElizaInferenceRegion,
		) => {},
		mmapEvict: (
			_c: ElizaInferenceContextHandle,
			_r: ElizaInferenceRegion,
		) => {},
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
		close: () => {},
	};
	return { ...base, ...overrides };
}

describe("reserveOrRamPressure", () => {
	it("maps allocator exhaustion to VoiceLifecycleError(ram-pressure)", async () => {
		const budget = testBudget(1 * MB);
		await expect(
			reserveOrRamPressure(budget, {
				modelId: "too-big",
				role: "vad",
				bytes: 8 * MB,
			}),
		).rejects.toMatchObject({
			name: "VoiceLifecycleError",
			code: "ram-pressure",
		});
	});

	it("passes a fitting reservation through untouched", async () => {
		const budget = testBudget(16 * MB);
		const r = await reserveOrRamPressure(budget, {
			modelId: "ok",
			role: "vad",
			bytes: 2 * MB,
		});
		expect(r.role).toBe("vad");
		r.release();
		expect(budget.snapshot()).toHaveLength(0);
	});
});

describe("GgmlSileroVad budget wire-up", () => {
	it("reserves at load and releases on close (allocator empty)", async () => {
		const budget = testBudget(16 * MB);
		const vad = await GgmlSileroVad.load({
			ffi: fakeVoiceFfi(),
			ctx: () => 1n,
			budget,
		});
		const rows = budget.snapshot();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.role).toBe("vad");
		expect(rows[0]?.bytes).toBe(VAD_RESERVE_BYTES);
		vad.close();
		expect(budget.snapshot()).toHaveLength(0);
		vad.close(); // idempotent
		expect(budget.snapshot()).toHaveLength(0);
	});

	it("over-budget arm throws ram-pressure and loads nothing", async () => {
		let opened = 0;
		const ffi = fakeVoiceFfi({
			vadOpen: () => {
				opened++;
				return 7n;
			},
		});
		await expect(
			GgmlSileroVad.load({ ffi, ctx: () => 1n, budget: testBudget(1 * MB) }),
		).rejects.toMatchObject({ code: "ram-pressure" });
		expect(opened).toBe(0);
	});

	it("releases the reservation when the native open throws", async () => {
		const budget = testBudget(16 * MB);
		const ffi = fakeVoiceFfi({
			vadOpen: () => {
				throw new Error("native open failed");
			},
		});
		await expect(
			GgmlSileroVad.load({ ffi, ctx: () => 1n, budget }),
		).rejects.toThrow(/native open failed/);
		expect(budget.snapshot()).toHaveLength(0);
	});
});

describe("GgmlWakeWordModel budget wire-up", () => {
	const wakeFfi = (overrides: Partial<ElizaInferenceFfi> = {}) =>
		fakeVoiceFfi({
			wakewordSupported: () => true,
			wakewordOpen: () => 9n,
			wakewordScore: () => 0.01,
			wakewordReset: () => {},
			wakewordClose: () => {},
			...overrides,
		});

	it("reserves at load and releases on close", async () => {
		const budget = testBudget(16 * MB);
		const model = await GgmlWakeWordModel.load({
			ffi: wakeFfi(),
			ctx: () => 1n,
			headName: "hey-eliza",
			budget,
		});
		const rows = budget.snapshot();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.role).toBe("wake-word");
		expect(rows[0]?.bytes).toBe(WAKE_WORD_RESERVE_BYTES);
		model.close();
		expect(budget.snapshot()).toHaveLength(0);
	});

	it("releases the reservation when the native open rejects the head", async () => {
		const budget = testBudget(16 * MB);
		const ffi = wakeFfi({
			wakewordOpen: () => {
				throw new Error("bad head");
			},
		});
		await expect(
			GgmlWakeWordModel.load({
				ffi,
				ctx: () => 1n,
				headName: "nope",
				budget,
			}),
		).rejects.toThrow(WakeWordUnavailableError);
		expect(budget.snapshot()).toHaveLength(0);
	});
});

describe("tryBuildFusedEotClassifier budget wire-up", () => {
	const eotFfi = () =>
		fakeVoiceFfi({
			eotSupported: () => true,
			eotScore: () => ({ targetProb: 0.5 }),
			tokenize: () => new Int32Array([1]),
		});

	it("reserves at build and releases on dispose", async () => {
		const budget = testBudget(64 * MB);
		const classifier = await tryBuildFusedEotClassifier({
			ffi: eotFfi(),
			getContext: () => 1n,
			budget,
		});
		expect(classifier).not.toBeNull();
		const rows = budget.snapshot();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.role).toBe("turn-detector");
		expect(rows[0]?.bytes).toBe(FUSED_EOT_SCORER_RESERVE_BYTES);
		classifier?.dispose();
		expect(budget.snapshot()).toHaveLength(0);
	});

	it("reserves nothing when the build lacks the EOT ABI", async () => {
		const budget = testBudget(64 * MB);
		const classifier = await tryBuildFusedEotClassifier({
			ffi: fakeVoiceFfi(),
			getContext: () => 1n,
			budget,
		});
		expect(classifier).toBeNull();
		expect(budget.snapshot()).toHaveLength(0);
	});
});

describe("VoicePipeline per-turn TTS transient reservation", () => {
	function makePreset(): SpeakerPreset {
		const embedding = new Float32Array([0.1, 0.2]);
		return {
			voiceId: "default",
			embedding,
			bytes: new Uint8Array(embedding.buffer.slice(0)),
		};
	}

	class SilentBackend {
		async synthesize(args: {
			phrase: { id: number; fromIndex: number; toIndex: number };
			cancelSignal: { cancelled: boolean };
			onKernelTick?: () => void;
		}) {
			args.onKernelTick?.();
			return {
				phraseId: args.phrase.id,
				fromIndex: args.phrase.fromIndex,
				toIndex: args.phrase.toIndex,
				pcm: new Float32Array(8).fill(0.1),
				sampleRate: 24000,
			};
		}
	}

	function fakeTranscriber(transcript: string): StreamingTranscriber {
		return {
			feed: () => {},
			async flush(): Promise<TranscriptUpdate> {
				return { partial: transcript, isFinal: true };
			},
			on: () => () => {},
			dispose: () => {},
		};
	}

	function buildPipeline(args: {
		budget: VoiceBudget;
		bytes: number;
		onTurnStarted?: () => void;
	}): VoicePipeline {
		const scheduler = new VoiceScheduler(
			{
				chunkerConfig: { maxTokensPerPhrase: 4 },
				preset: makePreset(),
				ringBufferCapacity: 4096,
				sampleRate: 24000,
			},
			{ backend: new SilentBackend(), sink: new InMemoryAudioSink() },
		);
		const drafter: DraftProposer = {
			propose: async () => [],
		};
		const verifier: TargetVerifier = {
			verify: async () => {
				args.onTurnStarted?.();
				return { accepted: [], done: true };
			},
		};
		return new VoicePipeline(
			{
				scheduler,
				transcriber: fakeTranscriber("hello there"),
				drafter,
				verifier,
				ttsTransientReservation: { bytes: args.bytes, budget: args.budget },
			},
			{ maxDraftTokens: 4 },
		);
	}

	it("reserves role=tts for the duration of the turn and releases after", async () => {
		const budget = testBudget(256 * MB);
		let rowsDuringTurn = -1;
		const pipeline = buildPipeline({
			budget,
			bytes: 100 * MB,
			onTurnStarted: () => {
				rowsDuringTurn = budget
					.snapshot()
					.filter((r) => r.role === "tts").length;
			},
		});
		const result = await pipeline.run({
			pcm: new Float32Array(2400),
			sampleRate: 16_000,
		});
		expect(result).toBe("done");
		expect(rowsDuringTurn).toBe(1);
		expect(budget.snapshot()).toHaveLength(0);
	});

	it("an over-budget turn fails loud with ram-pressure before ASR", async () => {
		const budget = testBudget(16 * MB);
		const pipeline = buildPipeline({ budget, bytes: 100 * MB });
		await expect(
			pipeline.run({ pcm: new Float32Array(2400), sampleRate: 16_000 }),
		).rejects.toBeInstanceOf(VoiceLifecycleError);
		expect(budget.snapshot()).toHaveLength(0);
	});
});

describe("FfiStreamingBackend budget wire-up", () => {
	const tmpDir = mkdtempSync(path.join(os.tmpdir(), "voice-budget-ffi-"));
	afterAll(() => {
		rmSync(tmpDir, { recursive: true, force: true });
	});

	function writeGguf(name: string, bytes: number): string {
		const p = path.join(tmpDir, name);
		writeFileSync(p, Buffer.alloc(bytes, 1));
		return p;
	}

	function fakeRuntime(session: Partial<FfiBackendSession>): FfiBackendRuntime {
		return {
			supported: () => true,
			async acquire(): Promise<FfiBackendSession> {
				return {
					binding: {} as FfiBackendSession["binding"],
					ctx: {} as FfiBackendSession["ctx"],
					runner: {} as FfiBackendSession["runner"],
					tokenize: () => new Int32Array(),
					mtp: null,
					draftModelPath: null,
					mmprojPath: null,
					...session,
				};
			},
			async release(): Promise<void> {},
		};
	}

	it("reserves text-target (file size) at load and releases on unload", async () => {
		const modelPath = writeGguf("target.gguf", 3 * MB);
		const budget = testBudget(64 * MB);
		const backend = new FfiStreamingBackend(fakeRuntime({}), { budget });
		await backend.load({ modelPath } as unknown as BackendPlan);
		const rows = budget.snapshot();
		expect(rows).toHaveLength(1);
		expect(rows[0]?.role).toBe("text-target");
		expect(rows[0]?.bytes).toBe(3 * MB);
		await backend.unload();
		expect(budget.snapshot()).toHaveLength(0);
	});

	it("reserves a separate MTP drafter GGUF under role=drafter", async () => {
		const modelPath = writeGguf("target2.gguf", 3 * MB);
		const draftPath = writeGguf("drafter.gguf", 1 * MB);
		const budget = testBudget(64 * MB);
		const backend = new FfiStreamingBackend(
			fakeRuntime({ draftModelPath: draftPath }),
			{ budget },
		);
		await backend.load({ modelPath } as unknown as BackendPlan);
		const roles = budget.snapshot().map((r) => r.role);
		expect(roles).toContain("text-target");
		expect(roles).toContain("drafter");
		await backend.unload();
		expect(budget.snapshot()).toHaveLength(0);
	});

	it("a text-target that cannot fit fails the load loudly", async () => {
		const modelPath = writeGguf("huge.gguf", 32 * MB);
		const budget = testBudget(16 * MB);
		const backend = new FfiStreamingBackend(fakeRuntime({}), { budget });
		await expect(
			backend.load({ modelPath } as unknown as BackendPlan),
		).rejects.toMatchObject({
			name: "BudgetExhaustedError",
		});
		expect(backend.hasLoadedModel()).toBe(false);
		expect(budget.snapshot()).toHaveLength(0);
	});
});

describe("FfiStreamingBackend generation lifecycle", () => {
	// Each step blocks the thread for 20 ms, like a synchronous FFI decode
	// step; the reply ends after 100 steps.
	function blockingBinding(steps: { count: number }) {
		return {
			llmStreamSupported: () => true,
			llmStreamOpen: () => ({}) as never,
			llmStreamPrefill: () => {},
			llmStreamNext: () => {
				const until = Date.now() + 20;
				while (Date.now() < until) {}
				steps.count += 1;
				return {
					text: "x",
					tokens: [1],
					done: steps.count >= 100,
					drafterDrafted: 0,
					drafterAccepted: 0,
				};
			},
			llmStreamCancel: () => {},
			llmStreamClose: () => {},
		};
	}

	async function loadedBackend(steps: { count: number }, released: string[]) {
		const runner = new FfiStreamingRunner(
			blockingBinding(steps) as never,
			{} as never,
		);
		const backend = new FfiStreamingBackend(
			{
				supported: () => true,
				async acquire(): Promise<FfiBackendSession> {
					return {
						binding: {} as FfiBackendSession["binding"],
						ctx: {} as FfiBackendSession["ctx"],
						runner: runner as unknown as FfiBackendSession["runner"],
						tokenize: () => new Int32Array([1]),
						mtp: null,
						draftModelPath: null,
						mmprojPath: null,
					};
				},
				async release(): Promise<void> {
					released.push(`released after ${steps.count} steps`);
				},
			},
			{},
		);
		await backend.load({ modelPath: "/model.gguf" } as unknown as BackendPlan);
		return backend;
	}

	it("stops a generation when its signal aborts", async () => {
		const steps = { count: 0 };
		const backend = await loadedBackend(steps, []);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 50);

		await expect(
			backend.generateWithUsage({
				prompt: "hi",
				maxTokens: 1000,
				signal: controller.signal,
			} as never),
		).rejects.toThrow("aborted");
		expect(steps.count).toBeLessThan(100);
	}, 10_000);

	it("ends running generations before unload releases the session", async () => {
		const steps = { count: 0 };
		const released: string[] = [];
		const backend = await loadedBackend(steps, released);
		const generation = backend.generateWithUsage({
			prompt: "hi",
			maxTokens: 1000,
		} as never);
		const outcome = generation.then(
			() => "completed",
			() => "stopped",
		);
		await new Promise((resolve) => setTimeout(resolve, 50));

		await backend.unload();

		expect(await outcome).toBe("stopped");
		expect(steps.count).toBeLessThan(100);
		expect(released).toEqual([`released after ${steps.count} steps`]);
	}, 10_000);

	it("refuses generations that start while unload is ending the running ones", async () => {
		const steps = { count: 0 };
		const released: string[] = [];
		const backend = await loadedBackend(steps, released);
		const first = backend
			.generateWithUsage({ prompt: "hi", maxTokens: 1000 } as never)
			.then(
				() => "completed",
				() => "stopped",
			);
		await new Promise((resolve) => setTimeout(resolve, 50));

		const unloading = backend.unload();
		// unload() is now waiting for the first generation to settle; the
		// session is still attached, so a new call must be refused rather
		// than opening a stream on a context that is about to be freed.
		const second = backend.generateWithUsage({
			prompt: "hi",
			maxTokens: 1000,
		} as never);
		await expect(second).rejects.toMatchObject({
			code: "LOCAL_MODEL_UNLOADING",
		});
		const stepsWhenRefused = steps.count;

		await unloading;

		expect(await first).toBe("stopped");
		expect(released).toEqual([`released after ${steps.count} steps`]);
		// No step ran after the refusal besides the one the first generation
		// was finishing when it was aborted.
		expect(steps.count - stepsWhenRefused).toBeLessThanOrEqual(1);
		expect(backend.hasLoadedModel()).toBe(false);
	}, 10_000);

	it("releases one native session once when unload callers overlap", async () => {
		const steps = { count: 0 };
		const released: string[] = [];
		const backend = await loadedBackend(steps, released);

		await Promise.all([backend.unload(), backend.unload()]);

		expect(released).toEqual(["released after 0 steps"]);
		expect(backend.hasLoadedModel()).toBe(false);
	});

	it("serializes overlapping model loads", async () => {
		const acquireResolvers: Array<() => void> = [];
		let acquiresInFlight = 0;
		let maxAcquiresInFlight = 0;
		let releases = 0;
		const backend = new FfiStreamingBackend({
			supported: () => true,
			async acquire(): Promise<FfiBackendSession> {
				acquiresInFlight += 1;
				maxAcquiresInFlight = Math.max(maxAcquiresInFlight, acquiresInFlight);
				await new Promise<void>((resolve) => acquireResolvers.push(resolve));
				acquiresInFlight -= 1;
				return {
					binding: {} as FfiBackendSession["binding"],
					ctx: {} as FfiBackendSession["ctx"],
					runner: {} as FfiBackendSession["runner"],
					tokenize: () => new Int32Array(),
					mtp: null,
					draftModelPath: null,
					mmprojPath: null,
				};
			},
			async release(): Promise<void> {
				releases += 1;
			},
		});

		const first = backend.load({
			modelPath: "/first.gguf",
		} as unknown as BackendPlan);
		const second = backend.load({
			modelPath: "/second.gguf",
		} as unknown as BackendPlan);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const acquiresBeforeFirstSettled = acquireResolvers.length;

		acquireResolvers[0]?.();
		await first;
		while (acquireResolvers.length < 2) {
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		acquireResolvers[1]?.();
		await second;

		expect(acquiresBeforeFirstSettled).toBe(1);
		expect(maxAcquiresInFlight).toBe(1);
		expect(releases).toBe(1);
		expect(backend.currentModelPath()).toBe("/second.gguf");
		await backend.unload();
	});
});
