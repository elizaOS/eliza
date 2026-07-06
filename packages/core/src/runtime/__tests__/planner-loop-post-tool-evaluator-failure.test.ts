/**
 * Covers the planner loop's post-tool evaluator-failure recovery: when the
 * in-loop evaluator model call throws AFTER a non-terminal tool already
 * succeeded, the loop relays the tool's truthful output instead of discarding
 * the turn — but still rethrows when nothing succeeded. Deterministic —
 * vitest-mocked `useModel` + injected `executeToolCall`/`evaluate`; no live model.
 */
import { describe, expect, it, vi } from "vitest";
import { runPlannerLoop } from "../planner-loop";

// Planner turn that emits exactly one non-terminal FILE tool call and no
// messageToUser — the shape from trajectory tj-dc0181fe5c9075 where FILE wrote
// the file, then the evaluator's model call 400'd.
function plannerEmitsFileCall() {
	return {
		useModel: vi.fn().mockResolvedValueOnce({
			text: "",
			toolCalls: [{ id: "call-1", name: "FILE", arguments: {} }],
			usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
		}),
	};
}

describe("planner-loop — post-tool evaluator failure recovery", () => {
	it("relays the successful tool result when the evaluator throws transiently", async () => {
		const wrote = "Wrote 16 bytes to /home/milady/hello-elizacode.txt";
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: wrote,
		}));
		// The in-loop evaluator model call fails exactly as elizaOS Cloud did
		// (HTTP 400 Bad Request) after FILE already wrote the file.
		const evaluate = vi.fn(async () => {
			throw new Error("Bad Request");
		});

		const result = await runPlannerLoop({
			runtime: plannerEmitsFileCall(),
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage ?? "").toContain(wrote);
	});

	it("does NOT mask a genuine failure — rethrows when no tool succeeded", async () => {
		const executeToolCall = vi.fn(async () => ({
			success: false,
			error: "disk full",
			text: "FILE failed: disk full",
		}));
		const evaluate = vi.fn(async () => {
			throw new Error("Bad Request");
		});

		await expect(
			runPlannerLoop({
				runtime: plannerEmitsFileCall(),
				context: { id: "ctx" },
				executeToolCall,
				evaluate,
			}),
		).rejects.toThrow("Bad Request");
	});

	it("does not regress the happy path — returns the evaluator's message on FINISH", async () => {
		const evaluatorMessage =
			"Created hello-elizacode.txt with ELIZA CODE WORKS.";
		const executeToolCall = vi.fn(async () => ({
			success: true,
			text: "Wrote 16 bytes to /home/milady/hello-elizacode.txt",
		}));
		const evaluate = vi.fn(async () => ({
			success: true,
			decision: "FINISH" as const,
			messageToUser: evaluatorMessage,
			thought: "Done.",
		}));

		const result = await runPlannerLoop({
			runtime: plannerEmitsFileCall(),
			context: { id: "ctx" },
			executeToolCall,
			evaluate,
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(evaluatorMessage);
	});
});
