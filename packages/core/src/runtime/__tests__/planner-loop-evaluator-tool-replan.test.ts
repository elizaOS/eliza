/**
 * Real parser + planner-loop integration, with a deterministic model boundary
 * and stateful tool fixture. This does not substitute for live Calendar QA.
 */
import { expect, it, vi } from "vitest";
import { parseEvaluatorOutput } from "../evaluator";
import { runPlannerLoop } from "../planner-loop";
import type { PlannerToolCall, PlannerTrajectory } from "../planner-types";

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

it.each([
	{ pendingIds: ["change", "verify"], selectedAfterLookup: "change" },
	{ pendingIds: ["verify", "change", "audit"], selectedAfterLookup: "change" },
])(
	"runs the grounded recommendation from $pendingIds without replanning or losing dependent calls",
	async ({ pendingIds, selectedAfterLookup }) => {
		const target = { id: "target", revision: 1 };
		const originalParams = {
			recordId: target.id,
			metadata: { source: "current-turn", expectedRevision: 1 },
		};
		const useModel = vi.fn().mockResolvedValueOnce({
			text: "",
			toolCalls: ["lookup", ...pendingIds].map((id) => ({
				id,
				name: id.toUpperCase(),
				arguments: originalParams,
			})),
		});
		const executed: string[] = [];
		const queuedAtEvaluation: string[][] = [];
		const executeToolCall = vi.fn(async (call: PlannerToolCall) => {
			expect(call.params).toEqual(originalParams);
			executed.push(call.id ?? "missing-id");
			if (call.id === "change") {
				expect(executed).toEqual(["lookup", "change"]);
				expect(target.revision).toBe(1);
				target.revision = 2;
			} else if (call.id !== "lookup") {
				// Verification depends on the recorded change, not just its plan.
				expect(target.revision).toBe(2);
			}
			return { success: true, text: JSON.stringify(target) };
		});
		const evaluate = vi.fn(
			({ trajectory }: { trajectory: PlannerTrajectory }) => {
				const pending = trajectory.plannedQueue.map(
					(call) => call.id ?? "missing-id",
				);
				queuedAtEvaluation.push(pending);
				expect(trajectory.steps.at(-1)?.result).toEqual({
					success: true,
					text: JSON.stringify(target),
				});
				return parseEvaluatorOutput({
					object: pending.length
						? {
								thought:
									"The latest result grounds the next queued call; retain the remaining work.",
								success: false,
								decision: "NEXT_RECOMMENDED",
								recommendedToolCallId:
									executed.length === 1 ? selectedAfterLookup : pending[0],
							}
						: {
								thought: "The change and dependent verification are recorded.",
								success: true,
								decision: "FINISH",
								messageToUser: "The record was updated and verified.",
							},
				});
			},
		);

		const result = await runPlannerLoop({
			runtime: { useModel },
			context: { id: "grounded-multiple-queued-calls" },
			executeToolCall,
			evaluate,
		});

		const remaining = pendingIds.filter((id) => id !== selectedAfterLookup);
		expect(executed).toEqual(["lookup", selectedAfterLookup, ...remaining]);
		expect(queuedAtEvaluation).toEqual([
			pendingIds,
			...remaining.map((_, index) => remaining.slice(index)),
			[],
		]);
		expect(useModel).toHaveBeenCalledTimes(1);
		expect(evaluate).toHaveBeenCalledTimes(executed.length);
		expect(result.trajectory.plannedQueue).toEqual([]);
		expect(result.trajectory.steps.map((step) => step.toolCall?.id)).toEqual(
			executed,
		);
		expect(result.status).toBe("finished");
	},
);

it.each([
	{
		reason: "unknown recommendation",
		decision: "NEXT_RECOMMENDED",
		recommendedToolCallId: "not-queued",
		lookupSuccess: true,
	},
	{
		reason: "already executed recommendation",
		decision: "NEXT_RECOMMENDED",
		recommendedToolCallId: "lookup",
		lookupSuccess: true,
	},
	{
		reason: "stale queued parameters",
		decision: "CONTINUE",
		lookupSuccess: true,
	},
	{ reason: "failed prerequisite", decision: "CONTINUE", lookupSuccess: false },
])(
	"replans on $reason without executing or silently repairing the old queue",
	async ({ reason, decision, recommendedToolCallId, lookupSuccess }) => {
		const useModel = vi
			.fn()
			.mockResolvedValueOnce({
				text: "",
				toolCalls: ["lookup", "old-change", "old-verify"].map((id) => ({
					id,
					name: id.toUpperCase(),
					arguments: { recordId: "old-target", expectedRevision: 1 },
				})),
			})
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "fresh-lookup",
						name: "LOOKUP",
						arguments: { recordId: "current-target" },
					},
				],
			});
		const lookupResult = {
			success: lookupSuccess,
			text: lookupSuccess
				? "The record is now revision 2; queued revision 1 is stale."
				: "The prerequisite lookup failed; no record was changed.",
		};
		const executeToolCall = vi.fn(async (call: PlannerToolCall) => {
			expect(["lookup", "fresh-lookup"]).toContain(call.id);
			return call.id === "lookup"
				? lookupResult
				: {
						success: true,
						text: "Fresh lookup complete; no record was changed.",
					};
		});
		const evaluate = vi
			.fn()
			.mockImplementationOnce(
				({ trajectory }: { trajectory: PlannerTrajectory }) => {
					expect(trajectory.plannedQueue.map((call) => call.id)).toEqual([
						"old-change",
						"old-verify",
					]);
					expect(trajectory.steps[0]?.result).toEqual(lookupResult);
					return parseEvaluatorOutput({
						object: {
							thought: reason,
							success: false,
							decision,
							...(recommendedToolCallId ? { recommendedToolCallId } : {}),
						},
					});
				},
			)
			.mockImplementationOnce(() =>
				parseEvaluatorOutput({
					object: {
						thought:
							"The fresh read is complete; no mutation was authorized by this replan.",
						success: lookupSuccess,
						decision: "FINISH",
						messageToUser: lookupSuccess
							? "The latest record was checked; nothing was changed."
							: "The original lookup failed. A fresh read completed, but nothing was changed.",
					},
				}),
			);

		const result = await runPlannerLoop({
			runtime: { useModel },
			context: { id: "invalid-or-stale-queued-call" },
			executeToolCall,
			evaluate,
		});

		expect(useModel).toHaveBeenCalledTimes(2);
		expect(executeToolCall.mock.calls.map(([call]) => call.id)).toEqual([
			"lookup",
			"fresh-lookup",
		]);
		expect(evaluate).toHaveBeenCalledTimes(2);
		const replanInput = JSON.stringify(useModel.mock.calls[1]);
		expect(replanInput).toContain(lookupResult.text);
		expect(replanInput).toContain("old-change");
		expect(replanInput).toContain("old-verify");
		expect(result.trajectory.steps[0]?.result).toEqual(lookupResult);
		expect(result.trajectory.plannedQueue).toEqual([]);
		expect(result.status).toBe("finished");
	},
);
