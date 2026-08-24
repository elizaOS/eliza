/**
 * Deterministic native-wire admission tests cover exact serialization,
 * zero-dispatch rejection, and retry mutation detection without a device.
 */

import { describe, expect, it, vi } from "vitest";
import { createNativeModelRequestGuard } from "./native-model-request";

describe("createNativeModelRequestGuard", () => {
	it("counts the exact final model-visible serialization", () => {
		const request = {
			prompt: "full native prompt",
			maxTokens: 64,
			stopSequences: ["<end_of_turn>"],
		};
		const serialized = JSON.stringify(request);
		const counter = vi.fn((body: string) => body.length);
		const guard = createNativeModelRequestGuard({
			provider: "native-test",
			model: "local.gguf",
			contextWindowTokens: 4096,
			outputReserveTokens: 64,
			projectRequest: () => ({ ...request }),
			countInputTokens: counter,
		});

		expect(guard.budget.inputTokens).toBe(serialized.length);
		expect(counter).toHaveBeenCalledWith(serialized);
		guard.assertBeforeAttempt();
		expect(guard.attempts).toBe(1);
	});

	it("rejects an over-budget request before dispatch", () => {
		const dispatch = vi.fn();
		expect(() => {
			const guard = createNativeModelRequestGuard({
				provider: "native-test",
				model: "local.gguf",
				contextWindowTokens: 100,
				outputReserveTokens: 10,
				projectRequest: () => ({ prompt: "complete" }),
				countInputTokens: () => 90,
			});
			guard.assertBeforeAttempt();
			dispatch();
		}).toThrowError(
			expect.objectContaining({ code: "MODEL_INPUT_OVER_BUDGET" }),
		);
		expect(dispatch).not.toHaveBeenCalled();
	});

	it("rejects mutation before a retry can dispatch", () => {
		const request = { prompt: "original", maxTokens: 32 };
		const dispatch = vi.fn();
		const guard = createNativeModelRequestGuard({
			provider: "native-test",
			model: "local.gguf",
			contextWindowTokens: 4096,
			outputReserveTokens: 32,
			projectRequest: () => ({ ...request }),
		});
		guard.assertBeforeAttempt();
		dispatch();

		request.prompt = "mutated after admission";
		expect(() => {
			guard.assertBeforeAttempt();
			dispatch();
		}).toThrowError(
			expect.objectContaining({ code: "MODEL_PREPARED_REQUEST_MUTATED" }),
		);
		expect(dispatch).toHaveBeenCalledTimes(1);
	});
});
