/**
 * A cancelled turn ends the Stage-1 response-handler evaluators as cancelled;
 * only a genuine evaluator failure is reported and skipped.
 */
import { describe, expect, it, vi } from "vitest";
import {
	type ResponseHandlerEvaluator,
	runResponseHandlerEvaluators,
} from "../src/runtime/response-handler-evaluators";
import { TurnAbortedError } from "../src/runtime/turn-controller";
import type { Memory } from "../src/types/memory";
import type { IAgentRuntime } from "../src/types/runtime";
import type { State } from "../src/types/state";

function run(evaluate: ResponseHandlerEvaluator["evaluate"]) {
	const reportError = vi.fn();
	const evaluator: ResponseHandlerEvaluator = {
		name: "test-evaluator",
		shouldRun: () => true,
		evaluate,
	};
	const promise = runResponseHandlerEvaluators({
		runtime: {
			responseHandlerEvaluators: [],
			reportError,
			logger: { warn: vi.fn() },
		} as unknown as IAgentRuntime,
		message: {} as Memory,
		state: {} as State,
		messageHandler: { plan: {} } as never,
		availableContexts: [],
		evaluators: [evaluator],
	});
	return { promise, reportError };
}

describe("runResponseHandlerEvaluators", () => {
	it("ends a cancelled turn without reporting an evaluator failure", async () => {
		const aborted = new TurnAbortedError("superseded by an edit");
		const { promise, reportError } = run(() => {
			throw aborted;
		});

		await expect(promise).rejects.toBe(aborted);
		expect(reportError).not.toHaveBeenCalled();
	});

	it("reports and skips an evaluator that fails", async () => {
		const { promise, reportError } = run(() => {
			throw new Error("broken");
		});

		await expect(promise).resolves.toMatchObject({
			errors: [{ evaluatorName: "test-evaluator", error: "broken" }],
		});
		expect(reportError).toHaveBeenCalledOnce();
	});
});
