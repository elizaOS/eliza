/**
 * Evaluator verdict parsing when the model answers with a tool invocation
 * instead of a verdict: native XML tool markup, a JSON tool-call shape, or a
 * structured non-verdict object. Such output is a CONTINUE verdict in substance
 * and must not be reported as a protocol failure, which the planner loop
 * answers by relaying the last tool text as the final message. Pure parser
 * coverage: no runtime, model, or database.
 */
import { describe, expect, it, vi } from "vitest";
import { parseEvaluatorOutput, runEvaluator } from "../evaluator";

describe("parseEvaluatorOutput: tool invocation instead of a verdict", () => {
	it("treats native XML tool markup as CONTINUE without a protocol failure", () => {
		// Live shape: Qwen continued the planner transcript with the next call.
		const output = parseEvaluatorOutput(
			[
				"<tool_call>",
				"<function=CALENDAR>",
				"<parameter=action>",
				"delete_event",
				"</parameter>",
				"<parameter=details>",
				'{"eventId": "event-96120c0059b5fbc7"}',
				"</parameter>",
				"</function>",
				"</tool_call>",
			].join("\n"),
		);
		expect(output.decision).toBe("CONTINUE");
		expect(output.protocolFailure).toBeUndefined();
		expect(output.parseError).toBe("response is not a single JSON object");
		expect(output.thought).toContain("tool invocation");
		expect(output.messageToUser).toBeUndefined();
		expect(output.nextTool).toBeUndefined();
	});

	it("treats a JSON tool-call object as CONTINUE without a protocol failure", () => {
		const output = parseEvaluatorOutput(
			JSON.stringify({
				name: "CALENDAR",
				parameters: { action: "delete_event", title: "Gym session" },
			}),
		);
		expect(output.decision).toBe("CONTINUE");
		expect(output.protocolFailure).toBeUndefined();
		expect(output.parseError).toBe("JSON object is not evaluator-shaped");
	});

	it("treats a structured tool call as CONTINUE without a protocol failure", () => {
		const output = parseEvaluatorOutput({
			object: { name: "SHELL", arguments: { command: "ls -la" } },
		});
		expect(output.decision).toBe("CONTINUE");
		expect(output.protocolFailure).toBeUndefined();
		expect(output.parseError).toContain("not evaluator-shaped");
	});

	it.each([
		{
			toolCalls: [{ name: "CALENDAR", arguments: { action: "delete_event" } }],
		},
		{
			tool_calls: [
				{ type: "function", function: { name: "CALENDAR", arguments: "{}" } },
			],
		},
		{ type: "function", function: { name: "CALENDAR", arguments: "{}" } },
	])(
		"recognizes wrapped tool-call output without dispatching it: %j",
		(object) => {
			for (const raw of [JSON.stringify(object), { object }]) {
				const output = parseEvaluatorOutput(raw);
				expect(output.decision).toBe("CONTINUE");
				expect(output.protocolFailure).toBeUndefined();
				expect(output.nextTool).toBeUndefined();
				expect(output.messageToUser).toBeUndefined();
			}
		},
	);

	it("recognizes native model toolCalls even with empty text", () => {
		const raw = {
			text: "",
			toolCalls: [
				{
					id: "call-1",
					name: "CALENDAR",
					arguments: { action: "delete_event" },
				},
			],
		};
		const output = parseEvaluatorOutput(raw);
		expect(output.decision).toBe("CONTINUE");
		expect(output.protocolFailure).toBeUndefined();
		expect(output.nextTool).toBeUndefined();
	});

	it("does not recover native tool-call companion prose as a finished lookup reply", async () => {
		const output = await runEvaluator({
			runtime: {
				useModel: vi.fn(async () => ({
					text: "Your matching calendar event is Project A.",
					toolCalls: [
						{
							id: "delete-1",
							name: "CALENDAR",
							arguments: { action: "delete_event", eventId: "target" },
						},
					],
				})),
			},
			context: { id: "delete-after-lookup" },
			trajectory: {
				context: { id: "delete-after-lookup" },
				archivedSteps: [],
				evaluatorOutputs: [],
				steps: [
					{
						iteration: 1,
						toolCall: {
							id: "lookup-1",
							name: "CALENDAR",
							params: { action: "list_events" },
						},
						result: {
							success: true,
							text: "Project A: event target",
							userFacingText: "Your matching calendar event is Project A.",
						},
					},
				],
				plannedQueue: [],
			},
		});
		expect(output.decision).toBe("CONTINUE");
		expect(output.success).toBe(false);
		expect(output.protocolFailure).toBeUndefined();
		expect(output.messageToUser).toBeUndefined();
		expect(output.nextTool).toBeUndefined();
	});

	it.each([
		{ name: "Alice" },
		{ action: "a description without arguments" },
		{ parameters: { title: "Meeting" } },
		{ command: "ls -la" },
		{ toolCalls: [] },
		{ toolCalls: [{ name: "Alice" }] },
		{ function: { name: "Alice" } },
	])("does not mistake an arbitrary object for a tool call: %j", (object) => {
		for (const raw of [JSON.stringify(object), { object }]) {
			const output = parseEvaluatorOutput(raw);
			expect(output.protocolFailure).toBe(true);
			expect(output.success).toBe(false);
			expect(output.nextTool).toBeUndefined();
		}
	});

	it("keeps the protocol failure for prose that is not a verdict", () => {
		const output = parseEvaluatorOutput(
			"I believe the work is complete and nothing else is needed.",
		);
		expect(output.decision).toBe("CONTINUE");
		expect(output.protocolFailure).toBe(true);
	});

	it("keeps the protocol failure for a non-tool object preceding a verdict", () => {
		const output = parseEvaluatorOutput(
			'{"content": "pretend document body"}{"success": true, "decision": "FINISH", "thought": "Saved."}',
		);
		expect(output.protocolFailure).toBe(true);
		expect(output.success).toBe(false);
	});
});
