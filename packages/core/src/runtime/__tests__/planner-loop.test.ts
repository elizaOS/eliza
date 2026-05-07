import { describe, expect, it, vi } from "vitest";
import { ModelType } from "../../types/model";
import { TrajectoryLimitExceeded } from "../limits";
import { parsePlannerOutput, runPlannerLoop } from "../planner-loop";

describe("v5 planner loop skeleton", () => {
	it("parses planner tool calls", () => {
		const output = parsePlannerOutput(`{
  "thought": "Fetch state.",
  "toolCalls": [
    {
      "name": "LOOKUP",
      "args": { "query": "status" }
    }
  ]
}`);

		expect(output.toolCalls).toEqual([
			{
				name: "LOOKUP",
				params: { query: "status" },
			},
		]);
	});

	it("calls ACTION_PLANNER, executes the first queued tool, then evaluates", async () => {
		const runtime = {
			useModel: vi.fn(async () => ({
				text: "",
				toolCalls: [
					{
						id: "call-1",
						name: "LOOKUP",
						arguments: { query: "status" },
					},
					{
						id: "call-2",
						name: "FOLLOW_UP",
						arguments: { id: "next" },
					},
				],
			})),
		};
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: "all good",
		}));
		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "FINISH" as const,
			thought: "Done.",
			messageToUser: "Done.",
		}));

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
		});

		expect(runtime.useModel).toHaveBeenCalledWith(
			ModelType.ACTION_PLANNER,
			expect.objectContaining({ prompt: expect.any(String) }),
			undefined,
		);
		expect(executeToolCall).toHaveBeenCalledWith(
			{ id: "call-1", name: "LOOKUP", params: { query: "status" } },
			expect.objectContaining({ iteration: 1 }),
		);
		expect(executeToolCall).toHaveBeenCalledTimes(1);
		expect(evaluate).toHaveBeenCalledTimes(1);
		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe("Done.");
	});

	it("evaluates terminal-only planner output without executing tools", async () => {
		const runtime = {
			useModel: vi.fn(
				async () => `{
  "thought": "Done.",
  "messageToUser": "Final answer.",
  "toolCalls": []
}`,
			),
		};
		const executeToolCall = vi.fn();
		const evaluate = vi.fn();

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
		});

		expect(executeToolCall).not.toHaveBeenCalled();
		expect(evaluate).not.toHaveBeenCalled();
		expect(result.finalMessage).toBe("Final answer.");
	});

	it("throws when the same tool failure repeats beyond the configured limit", async () => {
		const runtime = {
			useModel: vi.fn(async () => ({
				text: "",
				toolCalls: [{ id: "call-1", name: "LOOKUP", arguments: {} }],
			})),
		};
		const executeToolCall = vi.fn(async () => ({
			success: false,
			error: "boom",
		}));
		const evaluate = vi.fn(async () => ({
			success: false,
			decision: "CONTINUE" as const,
			thought: "Retry.",
		}));

		await expect(
			runPlannerLoop({
				runtime,
				context: { id: "ctx" },
				config: { maxRepeatedFailures: 1 },
				executeToolCall,
				evaluate,
			}),
		).rejects.toBeInstanceOf(TrajectoryLimitExceeded);
	});
});
