/**
 * Wiring tests for the on-device fused voice-turn entry (#8786). Proves the
 * device bridge is the real production caller for
 * `LocalInferenceEngine.runVoiceTurn`: it adapts the loaded
 * `CapacitorLlamaContext` into the `MtpTextRunner` the fused pipeline drives,
 * and forwards the turn to the engine. No native model — fakes stand in for the
 * context + engine so the wiring itself is the unit under test.
 */

import { describe, expect, it, vi } from "vitest";
import type { TranscriptionAudio } from "../../../services/voice/types";
import { NativePcmVoiceTurnCoordinator } from "../native-voice-capture";
import type { CapacitorLlamaContext } from "../types";
import {
	createCapacitorMtpTextRunner,
	type DeviceVoiceEngine,
	runDeviceVoiceTurn,
	type VoiceTurnExitReason,
} from "../voice-turn";

function fakeContext(
	overrides: Partial<CapacitorLlamaContext> = {},
): CapacitorLlamaContext {
	return {
		id: 1,
		gpu: false,
		reasonNoGPU: "",
		model: {} as CapacitorLlamaContext["model"],
		completion: vi.fn(async () => ({
			text: "four",
		})) as unknown as CapacitorLlamaContext["completion"],
		stopCompletion: vi.fn(async () => {}),
		tokenize: vi.fn(),
		detokenize: vi.fn(),
		embedding: vi.fn(),
		bench: vi.fn(),
		release: vi.fn(),
		...overrides,
	} as CapacitorLlamaContext;
}

const AUDIO: TranscriptionAudio = {
	pcm: new Float32Array([0.1, 0.2, 0.3]),
	sampleRate: 16_000,
};

describe("createCapacitorMtpTextRunner", () => {
	it("reports no drafter (on-device plain decode through the verifier)", () => {
		const runner = createCapacitorMtpTextRunner(fakeContext());
		expect(runner.hasDrafter()).toBe(false);
	});

	it("delegates generateWithVerifierEvents to context.completion and returns its text", async () => {
		const ctx = fakeContext();
		const runner = createCapacitorMtpTextRunner(ctx, { temperature: 0.5 });
		const result = await runner.generateWithVerifierEvents({
			prompt: "what is 2 + 2?",
			maxTokens: 8,
			topP: 0.9,
			stopSequences: ["</s>"],
			onVerifierEvent: () => {},
		});
		expect(result.text).toBe("four");
		expect(ctx.completion).toHaveBeenCalledTimes(1);
		expect(ctx.completion).toHaveBeenCalledWith(
			expect.objectContaining({
				prompt: "what is 2 + 2?",
				n_predict: 8,
				top_p: 0.9,
				temperature: 0.5,
				stop: ["</s>"],
			}),
		);
	});

	it("returns empty text without decoding when the signal is already aborted", async () => {
		const ctx = fakeContext();
		const runner = createCapacitorMtpTextRunner(ctx);
		const controller = new AbortController();
		controller.abort();
		const result = await runner.generateWithVerifierEvents({
			prompt: "hello",
			signal: controller.signal,
			onVerifierEvent: () => {},
		});
		expect(result.text).toBe("");
		expect(ctx.completion).not.toHaveBeenCalled();
	});

	it("aborting mid-decode stops the on-device completion (barge-in)", async () => {
		let resolveCompletion: ((v: { text: string }) => void) | null = null;
		const ctx = fakeContext({
			completion: vi.fn(
				() =>
					new Promise((resolve) => {
						resolveCompletion = resolve as (v: { text: string }) => void;
					}),
			) as unknown as CapacitorLlamaContext["completion"],
		});
		const runner = createCapacitorMtpTextRunner(ctx);
		const controller = new AbortController();
		const pending = runner.generateWithVerifierEvents({
			prompt: "a long answer",
			signal: controller.signal,
			onVerifierEvent: () => {},
		});
		controller.abort(); // barge-in
		expect(ctx.stopCompletion).toHaveBeenCalledTimes(1);
		resolveCompletion?.({ text: "partial" });
		await expect(pending).resolves.toEqual({ text: "partial" });
	});
});

describe("runDeviceVoiceTurn", () => {
	it("builds the device text runner and drives engine.runVoiceTurn", async () => {
		const ctx = fakeContext();
		const events = { onComplete: vi.fn() };
		const engine: DeviceVoiceEngine = {
			runVoiceTurn: vi.fn(async (): Promise<VoiceTurnExitReason> => "done"),
		};

		const exit = await runDeviceVoiceTurn({
			engine,
			context: ctx,
			audio: AUDIO,
			events,
			maxGeneratedTokens: 256,
		});

		expect(exit).toBe("done");
		expect(engine.runVoiceTurn).toHaveBeenCalledTimes(1);
		const [audioArg, optsArg] = (
			engine.runVoiceTurn as unknown as { mock: { calls: unknown[][] } }
		).mock.calls[0] as [TranscriptionAudio, Record<string, unknown>];
		expect(audioArg).toBe(AUDIO);
		expect(optsArg.events).toBe(events);
		expect(optsArg.maxGeneratedTokens).toBe(256);
		// The text runner handed to the engine is the device-context-backed one.
		const runner = optsArg.textRunner as ReturnType<
			typeof createCapacitorMtpTextRunner
		>;
		expect(runner.hasDrafter()).toBe(false);
		await runner.generateWithVerifierEvents({
			prompt: "x",
			onVerifierEvent: () => {},
		});
		expect(ctx.completion).toHaveBeenCalledTimes(1);
	});

	it("fires the next-stage preload predictor from the pipeline's onAsrComplete (#8809 C5)", async () => {
		const ctx = fakeContext();
		const callerOnAsrComplete = vi.fn();
		const onAsrStageComplete = vi.fn(async () => "eliza-1-4b" as string | null);
		// Structural stand-in for VoicePreloadPredictor — only onAsrStageComplete
		// is consumed by the wiring; type-cast keeps the test free of the arbiter.
		const predictor = { onAsrStageComplete } as unknown as Parameters<
			typeof runDeviceVoiceTurn
		>[0]["preloadPredictor"];

		const engine: DeviceVoiceEngine = {
			runVoiceTurn: vi.fn(async (): Promise<VoiceTurnExitReason> => "done"),
		};

		await runDeviceVoiceTurn({
			engine,
			context: ctx,
			audio: AUDIO,
			events: { onAsrComplete: callerOnAsrComplete },
			preloadPredictor: predictor,
		});

		const [, optsArg] = (
			engine.runVoiceTurn as unknown as { mock: { calls: unknown[][] } }
		).mock.calls[0] as [TranscriptionAudio, Record<string, unknown>];
		const wiredEvents = optsArg.events as {
			onAsrComplete?: (tokens: ReadonlyArray<unknown>) => void;
		};

		// The engine drives onAsrComplete the instant ASR finishes; the composed
		// hook must fire BOTH the caller's hook and the predictor's prediction.
		expect(onAsrStageComplete).not.toHaveBeenCalled();
		wiredEvents.onAsrComplete?.([]);
		expect(callerOnAsrComplete).toHaveBeenCalledTimes(1);
		expect(onAsrStageComplete).toHaveBeenCalledTimes(1);
	});

	it("leaves events untouched when no predictor is supplied", async () => {
		const events = { onComplete: vi.fn() };
		const engine: DeviceVoiceEngine = {
			runVoiceTurn: vi.fn(async (): Promise<VoiceTurnExitReason> => "done"),
		};
		await runDeviceVoiceTurn({
			engine,
			context: fakeContext(),
			audio: AUDIO,
			events,
		});
		const [, optsArg] = (
			engine.runVoiceTurn as unknown as { mock: { calls: unknown[][] } }
		).mock.calls[0] as [TranscriptionAudio, Record<string, unknown>];
		expect(optsArg.events).toBe(events);
	});

	it("propagates the engine's exit reason (token-cap / cancelled)", async () => {
		const engine: DeviceVoiceEngine = {
			runVoiceTurn: vi.fn(
				async (): Promise<VoiceTurnExitReason> => "cancelled",
			),
		};
		const exit = await runDeviceVoiceTurn({
			engine,
			context: fakeContext(),
			audio: AUDIO,
		});
		expect(exit).toBe("cancelled");
	});
});

describe("NativePcmVoiceTurnCoordinator", () => {
	it("rejects native turns before the capture lifecycle is started", async () => {
		const coordinator = new NativePcmVoiceTurnCoordinator({
			engine: {
				runVoiceTurn: vi.fn(async (): Promise<VoiceTurnExitReason> => "done"),
			},
			context: fakeContext(),
		});

		await expect(coordinator.acceptTurn({ audio: AUDIO })).rejects.toThrow(
			/start\(\)/,
		);
	});

	it("serializes completed native PCM turns through runDeviceVoiceTurn", async () => {
		const ctx = fakeContext();
		let releaseFirst: ((reason: VoiceTurnExitReason) => void) | null = null;
		const engine: DeviceVoiceEngine = {
			runVoiceTurn: vi.fn(
				() =>
					new Promise<VoiceTurnExitReason>((resolve) => {
						if (!releaseFirst) {
							releaseFirst = resolve;
							return;
						}
						resolve("token-cap");
					}),
			),
		};
		const coordinator = new NativePcmVoiceTurnCoordinator({
			engine,
			context: ctx,
			maxGeneratedTokens: 128,
		});

		coordinator.start();
		const first = coordinator.acceptTurn({ turnId: "turn-a", audio: AUDIO });
		const secondAudio: TranscriptionAudio = {
			pcm: new Float32Array([0.4, 0.5]),
			sampleRate: 16_000,
		};
		const second = coordinator.acceptTurn({
			turnId: "turn-b",
			audio: secondAudio,
			maxGeneratedTokens: 64,
		});

		await Promise.resolve();
		expect(engine.runVoiceTurn).toHaveBeenCalledTimes(1);
		releaseFirst?.("done");
		await expect(first).resolves.toEqual({
			turnId: "turn-a",
			exitReason: "done",
		});
		await expect(second).resolves.toEqual({
			turnId: "turn-b",
			exitReason: "token-cap",
		});
		expect(engine.runVoiceTurn).toHaveBeenCalledTimes(2);

		const firstCall = (
			engine.runVoiceTurn as unknown as { mock: { calls: unknown[][] } }
		).mock.calls[0] as [TranscriptionAudio, Record<string, unknown>];
		const secondCall = (
			engine.runVoiceTurn as unknown as { mock: { calls: unknown[][] } }
		).mock.calls[1] as [TranscriptionAudio, Record<string, unknown>];
		expect(firstCall[0]).toBe(AUDIO);
		expect(firstCall[1].maxGeneratedTokens).toBe(128);
		expect(secondCall[0]).toBe(secondAudio);
		expect(secondCall[1].maxGeneratedTokens).toBe(64);

		await coordinator.stop();
		expect(coordinator.isRunning).toBe(false);
	});
});
