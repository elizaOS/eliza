/**
 * `maxToolCalls` must bound the whole turn, not the portion of it that happens
 * to still be live. Compaction moves settled steps from `trajectory.steps` into
 * `trajectory.archivedSteps`; counting only the live half restarted the budget
 * across repeated replans, so a turn cannot execute unboundedly many
 * side-effecting tool calls under a cap the operator had set.
 */

import { describe, expect, it, vi } from "vitest";
import { TrajectoryLimitExceeded } from "../limits";
import { runPlannerLoop } from "../planner-loop";

describe("tool-call budget across replans", () => {
	it("counts archived tool calls toward maxToolCalls", async () => {
		const MAX = 3;
		// Bounds the test if the budget fails to fire; without it the loop runs
		// until the worker dies, which is the pre-fix behaviour.
		const HARD_STOP = 10;
		const longPayload = `result: ${"x".repeat(20_000)}`;
		let plannerCall = 0;
		const runtime = {
			redactSecrets: (text: string) => text,
			useModel: vi.fn(async () => {
				plannerCall += 1;
				if (plannerCall > HARD_STOP) {
					return {
						text: "",
						toolCalls: [
							{ id: "final", name: "REPLY", arguments: { text: "done" } },
						],
					};
				}
				return {
					text: "",
					toolCalls: [
						{
							id: `call-${plannerCall}`,
							name: "GENERATE",
							arguments: { n: plannerCall },
						},
					],
				};
			}),
			logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
		};
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: longPayload,
		}));

		let thrown: unknown;
		try {
			await runPlannerLoop({
				runtime,
				context: { id: "ctx" },
				config: {
					maxToolCalls: MAX,
					// Isolate the budget under test from the repeat guards.
					maxRepeatedToolCalls: 50,
					maxRepeatedFailures: 50,
					maxTerminalOnlyContinuations: 50,
				},
				executeToolCall,
				evaluate: vi.fn(async () => ({
					success: true,
					decision: "CONTINUE" as const,
					thought: "keep going",
				})),
			});
		} catch (error) {
			thrown = error;
		}

		expect(executeToolCall.mock.calls.length).toBe(MAX);
		expect(thrown).toBeInstanceOf(TrajectoryLimitExceeded);
		expect((thrown as TrajectoryLimitExceeded).kind).toBe("tool_calls");
	});
});
