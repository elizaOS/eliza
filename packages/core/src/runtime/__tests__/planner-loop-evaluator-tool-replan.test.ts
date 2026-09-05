/**
 * Real parser + planner-loop integration, with a deterministic model boundary
 * and stateful tool fixture. This does not substitute for live Calendar QA.
 */
import { expect, it, vi } from "vitest";
import { parseEvaluatorOutput } from "../evaluator";
import { runPlannerLoop } from "../planner-loop";
import type { PlannerToolCall } from "../planner-types";

it("replans an evaluator tool invocation after lookup and mutates only the planner-selected record once", async () => {
	const events = new Map([
		["target", "Project A"],
		["unrelated", "Project B"],
	]);
	const useModel = vi
		.fn()
		.mockResolvedValueOnce({
			text: "",
			toolCalls: [
				{
					id: "lookup",
					name: "CALENDAR",
					arguments: { action: "list_events" },
				},
			],
		})
		.mockResolvedValueOnce({
			text: "",
			toolCalls: [
				{
					id: "delete",
					name: "CALENDAR",
					arguments: { action: "delete_event", eventId: "target" },
				},
			],
		});
	const executeToolCall = vi.fn(async (call: PlannerToolCall) => {
		if (call.params?.action === "list_events") {
			return {
				success: true,
				text: JSON.stringify([...events]),
				userFacingText: "Project A is on your calendar.",
			};
		}
		expect(call.params).toEqual({ action: "delete_event", eventId: "target" });
		expect(events.delete(String(call.params?.eventId))).toBe(true);
		return { success: true, text: "Deleted event target." };
	});
	const evaluate = vi
		.fn()
		.mockImplementationOnce(async () =>
			parseEvaluatorOutput(
				"<tool_call><function=CALENDAR><parameter=action>delete_event</parameter><parameter=eventId>unrelated</parameter></function></tool_call>",
			),
		)
		.mockImplementationOnce(async () =>
			parseEvaluatorOutput({
				object: {
					success: true,
					decision: "FINISH",
					thought: "The requested event was removed.",
					messageToUser: "Project A is removed; Project B is unchanged.",
				},
			}),
		);

	const result = await runPlannerLoop({
		runtime: { useModel },
		context: { id: "calendar-replan" },
		executeToolCall,
		evaluate,
	});

	expect(result.status).toBe("finished");
	expect(result.finalMessage).toBe(
		"Project A is removed; Project B is unchanged.",
	);
	expect(useModel).toHaveBeenCalledTimes(2);
	const replanInput = JSON.stringify(useModel.mock.calls[1]);
	expect(replanInput).toContain("Project A");
	expect(replanInput).toContain("Project B");
	expect(replanInput).toContain("target");
	expect(replanInput).toContain("unrelated");
	expect(evaluate).toHaveBeenCalledTimes(2);
	expect(executeToolCall).toHaveBeenCalledTimes(2);
	expect([...events]).toEqual([["unrelated", "Project B"]]);
});
