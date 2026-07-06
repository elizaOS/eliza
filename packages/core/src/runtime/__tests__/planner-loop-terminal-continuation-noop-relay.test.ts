/**
 * Covers terminal-continuation recovery for no-op clarification actions. When a
 * successful tool structurally marks its result as `noop: true`, its clarification
 * question is the real user-facing outcome, so a stuck evaluator/planner loop must
 * relay that question instead of replacing it with a generic trajectory-limit
 * failure. Deterministic - vitest-mocked `useModel` + injected evaluator; no live
 * model.
 */
import { describe, expect, it, vi } from "vitest";
import type { TrajectoryLimitExceeded } from "../limits";
import { runPlannerLoop } from "../planner-loop";

function plannerEmitsNoopThenTerminalText(terminalText: string) {
	return {
		useModel: vi
			.fn()
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "call-1",
						name: "OWNER_GOALS",
						arguments: { action: "create_goal" },
					},
				],
				usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
			})
			.mockResolvedValueOnce({
				text: terminalText,
				usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
			}),
	};
}

function evaluatorRequestsAnotherIteration() {
	return vi.fn(async () => ({
		success: true,
		decision: "CONTINUE" as const,
		thought: "The previous result needs a final response.",
	}));
}

describe("planner-loop - terminal continuation noop clarification relay", () => {
	it("relays a successful noop action's clarification when terminal-only continuation exhaustion would otherwise discard it", async () => {
		const clarification =
			"What would success look like for you: completing the 5K in a target time, distance, or consistency goal?";
		const runtime = plannerEmitsNoopThenTerminalText(
			"I need one more detail before I can set that goal.",
		);
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: clarification,
			data: {
				noop: true,
				error: "NOOP_GOAL_UNGROUNDED",
				suggestedOperation: "create_goal",
			},
		}));
		const evaluate = evaluatorRequestsAnotherIteration();

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			config: { maxTerminalOnlyContinuations: 0 },
			executeToolCall,
			evaluate,
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(clarification);
		expect(executeToolCall).toHaveBeenCalledTimes(1);
		expect(evaluate).toHaveBeenCalledTimes(2);
		expect(runtime.useModel).toHaveBeenCalledTimes(2);
	});

	it("does not leak diagnostic text when the successful tool lacks the noop marker", async () => {
		const shellLog =
			"$ cat secrets.txt\nexit 0\ncwd=/home/milady\nAWS_SECRET=leak-me";
		const runtime = plannerEmitsNoopThenTerminalText(
			"I need to call SHELL again before answering.",
		);
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: shellLog,
		}));
		const evaluate = evaluatorRequestsAnotherIteration();

		await expect(
			runPlannerLoop({
				runtime,
				context: { id: "ctx" },
				config: { maxTerminalOnlyContinuations: 0 },
				executeToolCall,
				evaluate,
			}),
		).rejects.toMatchObject({
			kind: "terminal_only_continuations",
		} satisfies Partial<TrajectoryLimitExceeded>);
	});

	it("accepts the noop marker when ActionResult values were nested under data.values", async () => {
		const clarification =
			"Which deadline should I use before I create that reminder?";
		const runtime = plannerEmitsNoopThenTerminalText(
			"I need to keep working on the reminder.",
		);
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: clarification,
			data: {
				values: {
					noop: true,
				},
			},
		}));
		const evaluate = evaluatorRequestsAnotherIteration();

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			config: { maxTerminalOnlyContinuations: 0 },
			executeToolCall,
			evaluate,
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(clarification);
	});
});
