/**
 * Covers the coding-mode planner model-call wall-clock boundary. A single
 * stalled first `useModel` (live: 63s, only the messageHandler stage recorded,
 * no file, no reply) must not hang the turn: the loop aborts the call at its
 * deadline and RESOLVES with an honest fail-fast reply. A non-coding turn with
 * the same stalled call keeps its exact prior behavior (no timeout guard).
 * Deterministic harness over the real `runPlannerLoop` contract with fake
 * timers and a stub `useModel` that never resolves.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	PLANNER_MODEL_CALL_TIMEOUT_MESSAGE,
	runPlannerLoop,
} from "../planner-loop";

const ENV_KEY = "ELIZA_CODING_PLANNER_CALL_TIMEOUT_MS";

describe("planner-loop — coding-mode model-call timeout boundary", () => {
	let original: string | undefined;

	beforeEach(() => {
		original = process.env[ENV_KEY];
		vi.useFakeTimers();
	});

	afterEach(() => {
		if (original === undefined) {
			delete process.env[ENV_KEY];
		} else {
			process.env[ENV_KEY] = original;
		}
		vi.useRealTimers();
	});

	it("resolves with an honest fail-fast reply when the coding model call stalls past the deadline", async () => {
		process.env[ENV_KEY] = "1000";
		let capturedSignal: AbortSignal | undefined;
		const runtime = {
			useModel: vi.fn(
				(_modelType: unknown, modelParams: { signal?: AbortSignal }) => {
					capturedSignal = modelParams.signal;
					// The observed hang: the first (and only) planner generation never
					// returns.
					return new Promise<never>(() => {});
				},
			),
			logger: { debug: vi.fn(), warn: vi.fn() },
		};
		const executeToolCall = vi.fn();
		const evaluate = vi.fn();

		const loopPromise = runPlannerLoop({
			// biome-ignore lint/suspicious/noExplicitAny: minimal deterministic stub runtime for the loop contract.
			runtime: runtime as any,
			context: { id: "ctx" },
			codingMode: true,
			tools: [{ name: "FILE", description: "Write a file to disk." }],
			executeToolCall,
			evaluate,
			// biome-ignore lint/suspicious/noExplicitAny: partial loop params sufficient for this path.
		} as any);

		let settled = false;
		void loopPromise.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);

		// Before the deadline the turn is still pending — the guard has not fired.
		await vi.advanceTimersByTimeAsync(500);
		expect(settled).toBe(false);

		// Crossing the deadline aborts the call and finishes the turn.
		await vi.advanceTimersByTimeAsync(600);
		const result = await loopPromise;

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(PLANNER_MODEL_CALL_TIMEOUT_MESSAGE);
		expect((result.finalMessage ?? "").trim().length).toBeGreaterThan(0);
		expect(runtime.useModel).toHaveBeenCalledTimes(1);
		// The abort seam actually engaged, so an honoring adapter cancels its
		// socket rather than leaking the request forever.
		expect(capturedSignal?.aborted).toBe(true);
		// The turn never reached tool execution.
		expect(executeToolCall).not.toHaveBeenCalled();
	});

	it("does NOT engage the timeout guard on a non-coding turn (behavior unchanged)", async () => {
		process.env[ENV_KEY] = "1000";
		const runtime = {
			useModel: vi.fn(() => new Promise<never>(() => {})),
			logger: { debug: vi.fn(), warn: vi.fn() },
		};

		const loopPromise = runPlannerLoop({
			// biome-ignore lint/suspicious/noExplicitAny: minimal deterministic stub runtime for the loop contract.
			runtime: runtime as any,
			context: { id: "ctx" },
			tools: [{ name: "FILE", description: "Write a file to disk." }],
			executeToolCall: vi.fn(),
			evaluate: vi.fn(),
			// biome-ignore lint/suspicious/noExplicitAny: partial loop params sufficient for this path.
		} as any);

		let settled = false;
		void loopPromise.then(
			() => {
				settled = true;
			},
			() => {
				settled = true;
			},
		);

		// Advance well past the coding deadline: a non-coding turn has no
		// wall-clock guard, so the stalled call keeps the turn pending.
		await vi.advanceTimersByTimeAsync(5000);
		expect(settled).toBe(false);
	});
});
