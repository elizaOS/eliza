/**
 * Guards failed-operation authority when later calls use the same tool for a
 * different entity or argument set. Deterministic planner and evaluator mocks
 * exercise both terminal replies and evaluator-protocol recovery.
 */

import { describe, expect, it, vi } from "vitest";
import { runPlannerLoop } from "../planner-loop";

const failureA = "Note A could not be updated.";
const successB = "Note B was updated.";

function plannerToolCall(id: string, title: string) {
	return {
		text: "",
		toolCalls: [
			{
				id: `call-${id}`,
				name: "VIEWS",
				arguments: {
					action: "interact",
					view: "notes",
					capability: "update-note",
					params: { id, title },
				},
			},
		],
	};
}

function runtimeForFailureThenSuccessThenReply() {
	return {
		useModel: vi
			.fn()
			.mockResolvedValueOnce(plannerToolCall("note-a", "A"))
			.mockResolvedValueOnce(plannerToolCall("note-b", "B"))
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "reply",
						name: "REPLY",
						arguments: { text: "Both notes were updated." },
					},
				],
			}),
	};
}

function executeFailureAThenSuccessB() {
	return vi
		.fn()
		.mockResolvedValueOnce({
			success: false,
			error: "note-a-conflict",
			text: failureA,
			userFacingText: failureA,
		})
		.mockResolvedValueOnce({
			success: true,
			text: successB,
			userFacingText: successB,
		});
}

describe("planner-loop failed-operation correlation", () => {
	it("clears a failure only for the same operation despite argument key order", async () => {
		const runtime = {
			useModel: vi
				.fn()
				.mockResolvedValueOnce(plannerToolCall("note-a", "A"))
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "call-note-a-retry",
							name: "VIEWS",
							arguments: {
								params: { title: "A", id: "note-a" },
								capability: "update-note",
								view: "notes",
								action: "interact",
							},
						},
					],
				})
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "reply",
							name: "REPLY",
							arguments: { text: "The note was updated." },
						},
					],
				}),
		};
		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall: vi
				.fn()
				.mockResolvedValueOnce({
					success: false,
					error: "note-a-conflict",
					text: failureA,
					userFacingText: failureA,
				})
				.mockResolvedValueOnce({
					success: true,
					text: "Retry succeeded.",
					userFacingText: "Retry succeeded.",
				}),
			evaluate: vi
				.fn()
				.mockResolvedValueOnce({
					success: false,
					decision: "CONTINUE",
					thought: "Retry the same mutation.",
				})
				.mockResolvedValueOnce({
					success: false,
					decision: "CONTINUE",
					thought: "Return the successful outcome.",
				}),
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe("The note was updated.");
		expect(runtime.useModel).toHaveBeenCalledTimes(3);
	});

	it("keeps failed entity A authoritative when a terminal REPLY follows successful entity B", async () => {
		const runtime = runtimeForFailureThenSuccessThenReply();
		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall: executeFailureAThenSuccessB(),
			evaluate: vi
				.fn()
				.mockResolvedValueOnce({
					success: false,
					decision: "CONTINUE",
					thought: "Retry another requested mutation.",
				})
				.mockResolvedValueOnce({
					success: false,
					decision: "CONTINUE",
					thought: "Return a grounded summary.",
				}),
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(failureA);
		expect(result.finalMessage).not.toContain("Both notes were updated");
		expect(runtime.useModel).toHaveBeenCalledTimes(3);
	});

	it("does not relay successful B when evaluator protocol fails after failed A", async () => {
		const runtime = runtimeForFailureThenSuccessThenReply();
		const result = await runPlannerLoop({
			runtime,
			context: { id: "ctx" },
			executeToolCall: executeFailureAThenSuccessB(),
			evaluate: vi
				.fn()
				.mockResolvedValueOnce({
					success: false,
					decision: "CONTINUE",
					thought: "Continue after the first failure.",
				})
				.mockResolvedValueOnce({
					success: false,
					decision: "CONTINUE",
					thought: "Invalid evaluator envelope.",
					protocolFailure: true,
				}),
		});

		expect(result.status).toBe("finished");
		expect(result.finalMessage).toBe(failureA);
		expect(result.finalMessage).not.toBe(successB);
		expect(runtime.useModel).toHaveBeenCalledTimes(3);
	});
});
