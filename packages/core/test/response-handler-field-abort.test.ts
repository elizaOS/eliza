/**
 * A cancelled turn ends the Stage-1 response-handler field dispatch as
 * cancelled; only a genuine field failure is reported and skipped.
 */
import { describe, expect, it, vi } from "vitest";
import {
	type ResponseHandlerFieldEvaluator,
	ResponseHandlerFieldRegistry,
} from "../src/runtime/response-handler-fields";
import { TurnAbortedError } from "../src/runtime/turn-aborted-error";
import type { Memory } from "../src/types/memory";
import type { IAgentRuntime } from "../src/types/runtime";
import type { State } from "../src/types/state";

function field(
	name: string,
	priority: number,
	overrides: Partial<ResponseHandlerFieldEvaluator>,
): ResponseHandlerFieldEvaluator {
	return {
		name,
		description: "Test field.",
		schema: { type: "string" },
		priority,
		...overrides,
	};
}

function dispatch(evaluators: ResponseHandlerFieldEvaluator[]) {
	const reportError = vi.fn();
	const registry = new ResponseHandlerFieldRegistry();
	for (const evaluator of evaluators) registry.register(evaluator);
	const promise = registry.dispatch({
		rawParsed: { first: "one", second: "two" },
		runtime: {
			reportError,
			logger: { warn: vi.fn() },
		} as unknown as IAgentRuntime,
		message: {} as Memory,
		state: { values: {}, data: {}, text: "" } as State,
		senderRole: "OWNER",
		turnSignal: new AbortController().signal,
	});
	return { promise, reportError };
}

describe("ResponseHandlerFieldRegistry.dispatch", () => {
	it("ends a cancelled turn without reporting a field failure when a handler aborts", async () => {
		const aborted = new TurnAbortedError("user stopped");
		const secondRan = vi.fn();
		const { promise, reportError } = dispatch([
			field("first", 10, {
				handle: () => {
					throw aborted;
				},
			}),
			field("second", 20, {
				handle: () => {
					secondRan();
					return undefined;
				},
			}),
		]);

		await expect(promise).rejects.toBe(aborted);
		expect(reportError).not.toHaveBeenCalled();
		expect(secondRan).not.toHaveBeenCalled();
	});

	it("ends a cancelled turn without reporting a field failure when a parse aborts", async () => {
		const aborted = new TurnAbortedError("superseded by an edit");
		const { promise, reportError } = dispatch([
			field("first", 10, {
				parse: () => {
					throw aborted;
				},
			}),
			field("second", 20, {}),
		]);

		await expect(promise).rejects.toBe(aborted);
		expect(reportError).not.toHaveBeenCalled();
	});

	it("reports and skips a field that fails, and still runs the next field", async () => {
		const secondRan = vi.fn();
		const { promise, reportError } = dispatch([
			field("first", 10, {
				handle: () => {
					throw new Error("broken");
				},
			}),
			field("second", 20, {
				handle: () => {
					secondRan();
					return undefined;
				},
			}),
		]);

		await expect(promise).resolves.toMatchObject({
			fieldErrors: { first: "broken" },
		});
		expect(reportError).toHaveBeenCalledOnce();
		expect(secondRan).toHaveBeenCalledOnce();
	});
});
