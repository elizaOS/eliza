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
