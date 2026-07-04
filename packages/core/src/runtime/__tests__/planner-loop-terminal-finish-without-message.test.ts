/**
 * Guards that a terminal-only FINISH verdict is honored even when the evaluator
 * omits `messageToUser`: the loop falls back to the planner's terminal text
 * instead of coercing FINISH→CONTINUE and burning the terminal-continuation cap.
 * Deterministic — vitest-mocked `useModel`; no live model.
 */
import { describe, expect, it, vi } from "vitest";
import { runPlannerLoop } from "../planner-loop";

/**
 * Regression: a FINISH verdict on a terminal-only planner iteration must not
 * be coerced to CONTINUE just because the evaluator omitted `messageToUser`.
 *
 * Live failure (MMLU through the benchmark server, gemma-4-31b and
 * gpt-oss-120b alike): the planner called a capture tool whose result has no
 * `userFacingText`, then answered terminally ("B") on every following
 * iteration. The evaluator returned `{success: true, decision: "FINISH"}`
 * with only a `thought` each time, and
 * `repairFinishedToolTurnWithoutUserMessage` rewrote that FINISH into
 * CONTINUE. Three coerced continuations tripped
 * `terminal_only_continuations (3/2)` and the user got the generic apology —
 * even though the loop's own FINISH path already falls back to the planner's
 * terminal message (`evaluator.messageToUser ?? plannerOutput.messageToUser`).
 */
describe("planner-loop — terminal-only FINISH without evaluator message", () => {
	it("finishes with the planner's terminal message instead of burning terminal_only_continuations", async () => {
		const evaluatorFinishNoMessage = {
			text: JSON.stringify({
				success: true,
				decision: "FINISH",
				thought: "The capture tool ran and the answer B was recorded.",
			}),
			usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
		};
		const runtime = {
			useModel: vi
				.fn()
				// Planner 1: native tool call, no messageToUser.
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [{ id: "call-1", name: "CAPTURE_ANSWER", arguments: {} }],
					usage: { promptTokens: 100, completionTokens: 10, totalTokens: 110 },
				})
				// Evaluator after the tool ran: FINISH, no messageToUser. The
				// tool result has no userFacingText, so this one IS coerced to
				// CONTINUE (unchanged behavior) and the planner is re-asked.
				.mockResolvedValueOnce(evaluatorFinishNoMessage)
				// Planner 2: terminal-only answer, no tool calls.
				.mockResolvedValueOnce({
					text: "B",
					usage: { promptTokens: 100, completionTokens: 2, totalTokens: 102 },
				})
				// Evaluator on the terminal-only iteration: FINISH, no
				// messageToUser. Must finish with the planner's "B" — not be
				// coerced into another continuation.
				.mockResolvedValueOnce(evaluatorFinishNoMessage),
		};
		const executeToolCall = vi.fn(async () => ({
			success: true,
			// Diagnostic-only capture confirmation; deliberately no
			// userFacingText (mirrors BENCHMARK_ACTION).
			text: 'Benchmark action captured: {"answer":"B"}',
		}));

		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall,
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe("B");
		// Planner ×2 + evaluator ×2 — no extra replan rounds.
		expect(runtime.useModel).toHaveBeenCalledTimes(4);
	});
});
