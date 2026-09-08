/**
 * Exercises CALCULATE through the real planner loop, action handler, result
 * mapping, and evaluator. Queued model outputs prove that computed evidence
 * reaches evaluation and cannot replace the model's conversational answer or
 * prematurely end compound work. No live model or external services are used.
 */
import { describe, expect, it, vi } from "vitest";
import {
	actionResultToPlannerToolResult,
	runPlannerLoop,
} from "../../runtime/planner-loop.ts";
import type {
	ContextObject,
	PlannerRuntime,
	PlannerToolCall,
} from "../../runtime/planner-types.ts";
import { ModelType } from "../../types/model.ts";
import { calculateAction } from "./actions/calculate.ts";

function calculationCall(id: string, expression: string) {
	return {
		text: "",
		toolCalls: [{ id, name: "CALCULATE", arguments: { expression } }],
	};
}

function evaluatorReply(messageToUser: string) {
	return JSON.stringify({
		success: true,
		decision: "FINISH",
		thought: "The computed results answer the complete user request.",
		messageToUser,
	});
}

function executor() {
	return vi.fn(async (call: PlannerToolCall) => {
		expect(call.name).toBe("CALCULATE");
		const result = await calculateAction.handler(
			{} as never,
			{} as never,
			undefined,
			{ parameters: call.params },
		);
		if (!result || typeof result !== "object") {
			throw new Error("CALCULATE did not return its action result");
		}
		return actionResultToPlannerToolResult(result);
	});
}

function requestContext(request: string): ContextObject {
	return {
		id: "calculate-request",
		events: [
			{
				id: "user-request",
				type: "message",
				message: { role: "user", content: request },
			},
		],
	};
}

const tools = [{ name: "CALCULATE", description: calculateAction.description }];

describe("CALCULATE planner-owned replies", () => {
	it.each([
		{
			name: "ordinary arithmetic",
			request: "What is 341 times 17?",
			reply: "The product is 5,797.",
		},
		{
			name: "arithmetic with an explanation",
			request:
				"What is 341 times 17? Explain it by splitting 17 into 10 and 7.",
			reply:
				"The product is 5,797: 341 times 10 gives 3,410, and 341 times 7 gives 2,387; adding them gives 5,797.",
		},
	])(
		"evaluates the full request before answering: $name",
		async ({ request, reply }) => {
			const useModel = vi
				.fn<PlannerRuntime["useModel"]>()
				.mockResolvedValueOnce(calculationCall("multiply", "341 * 17"))
				.mockResolvedValueOnce(evaluatorReply(reply));
			const executeToolCall = executor();

			const result = await runPlannerLoop({
				runtime: { useModel },
				context: requestContext(request),
				tools,
				executeToolCall,
			});

			expect(useModel.mock.calls.map(([modelType]) => modelType)).toEqual([
				ModelType.ACTION_PLANNER,
				ModelType.RESPONSE_HANDLER,
			]);
			const evaluatorInput = JSON.stringify(
				useModel.mock.calls[1]?.[1].messages,
			);
			expect(evaluatorInput).toContain(request);
			expect(evaluatorInput).toContain("341 * 17 = 5797");
			expect(result.trajectory.steps[0]?.result?.data).toEqual({
				actionName: "CALCULATE",
				expression: "341 * 17",
				result: "5797",
				exact: true,
				values: { success: true, result: "5797", exact: true },
			});
			expect(result.evaluator?.messageToUser).toBe(reply);
			expect(result.finalMessage).toBe(reply);
			expect(executeToolCall).toHaveBeenCalledTimes(1);
		},
	);

	it("lets the evaluator continue a compound request after the first exact result", async () => {
		const request = "Multiply 341 by 17, then calculate half of that product.";
		const reply = "The product is 5,797, and half of it is 2,898.5.";
		const useModel = vi
			.fn<PlannerRuntime["useModel"]>()
			.mockResolvedValueOnce(calculationCall("multiply", "341 * 17"))
			.mockResolvedValueOnce(
				JSON.stringify({
					success: true,
					decision: "CONTINUE",
					thought:
						"The product is computed, but the requested half still needs calculation.",
				}),
			)
			.mockResolvedValueOnce(calculationCall("halve", "5797 / 2"))
			.mockResolvedValueOnce(evaluatorReply(reply));
		const executeToolCall = executor();

		const result = await runPlannerLoop({
			runtime: { useModel },
			context: requestContext(request),
			tools,
			executeToolCall,
		});

		expect(executeToolCall.mock.calls.map(([call]) => call.params)).toEqual([
			{ expression: "341 * 17" },
			{ expression: "5797 / 2" },
		]);
		expect(useModel.mock.calls.map(([modelType]) => modelType)).toEqual([
			ModelType.ACTION_PLANNER,
			ModelType.RESPONSE_HANDLER,
			ModelType.ACTION_PLANNER,
			ModelType.RESPONSE_HANDLER,
		]);
		const evaluatorInput = JSON.stringify(useModel.mock.calls[3]?.[1].messages);
		expect(evaluatorInput).toContain("341 * 17 = 5797");
		expect(evaluatorInput).toContain(
			"5797 / 2 = 2898.5 (floating-point; 15 significant digits)",
		);
		expect(
			result.trajectory.steps.map((step) => step.result?.data?.result),
		).toEqual(["5797", "2898.5"]);
		expect(result.evaluator?.messageToUser).toBe(reply);
		expect(result.finalMessage).toBe(reply);
	});
});
