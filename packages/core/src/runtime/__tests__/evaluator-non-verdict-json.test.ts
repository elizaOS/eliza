/**
 * Real evaluator recovery and planner loop with queued model outputs. Whole
 * JSON payloads are not free-form conversational replies; a malformed verdict
 * must leave remaining work to the planner without repeating settled effects.
 */
import { describe, expect, it, vi } from "vitest";
import { ModelType } from "../../types/model";
import { runEvaluator } from "../evaluator";
import { runPlannerLoop } from "../planner-loop";
import type {
	EvaluatorModelResult,
	PlannerToolCall,
	PlannerTrajectory,
} from "../planner-types";

const schemaPayloads: EvaluatorModelResult[] = [
	'{"type":"object"}',
	'```json\n{"type":"object"}\n```',
	'<think>Internal reasoning</think>{"type":"object"}',
	'{"properties":{"response":{"type":"string"}},"required":["response"]}',
	'[{"title":"Temporary event","eventId":"fixture"}]',
	{ text: '{"type":"object"}' },
	{ object: { type: "object" } },
	{ object: { type: "object" }, text: "The first operation is done." },
];

function trajectory(): PlannerTrajectory {
	return {
		context: { id: "schema-recovery" },
		archivedSteps: [],
		evaluatorOutputs: [],
		plannedQueue: [],
		steps: [
			{
				iteration: 1,
				toolCall: {
					id: "read-1",
					name: "CALENDAR",
					params: { action: "search_events" },
				},
				result: {
					success: true,
					transcriptVisibility: "internal",
					turnComplete: false,
					data: { events: [] },
				},
			},
		],
	};
}

describe("non-verdict JSON at the evaluator boundary", () => {
	it.each(schemaPayloads)(
		"does not promote %j into user-facing prose",
		async (raw) => {
			const output = await runEvaluator({
				runtime: { useModel: vi.fn(async () => raw) },
				context: { id: "schema-recovery" },
				trajectory: trajectory(),
			});
			expect(output.decision).toBe("CONTINUE");
			expect(output.success).toBe(false);
			expect(output.messageToUser).toBeUndefined();
			expect(output.nextTool).toBeUndefined();
			expect(output.protocolFailure).toBeUndefined();
		},
	);

	it("preserves explicitly selected JSON inside a valid evaluator message", async () => {
		const reply = '{"type":"object"}';
		const output = await runEvaluator({
			runtime: {
				useModel: vi.fn(async () =>
					JSON.stringify({
						success: true,
						decision: "FINISH",
						thought: "The user requested this exact schema.",
						messageToUser: reply,
					}),
				),
			},
			context: { id: "requested-schema" },
			trajectory: trajectory(),
		});
		expect(output.decision).toBe("FINISH");
		expect(output.messageToUser).toBe(reply);
	});

	it("retains genuine free-form prose recovery", async () => {
		const reply = "The temporary event is absent from the calendar.";
		const output = await runEvaluator({
			runtime: { useModel: vi.fn(async () => reply) },
			context: { id: "read-only" },
			trajectory: trajectory(),
		});
		expect(output.decision).toBe("FINISH");
		expect(output.messageToUser).toBe(reply);
	});
});

describe("non-verdict evaluator JSON leaves remaining work to the real planner", () => {
	it.each(["noop", "applied"] as const)(
		"opens Home after %s Calendar work without repeating it",
		async (outcome) => {
			const calendarParams = {
				action: outcome === "noop" ? "search_events" : "delete_event",
				eventId: "temporary-event",
			};
			const useModel = vi
				.fn()
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{ id: "calendar-1", name: "CALENDAR", arguments: calendarParams },
					],
				})
				.mockResolvedValueOnce('{"type":"object"}')
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "calendar-repeat",
							name: "CALENDAR",
							arguments: calendarParams,
						},
						{
							id: "home-1",
							name: "VIEWS",
							arguments: { action: "open", view: "home" },
						},
					],
				})
				.mockResolvedValueOnce(
					JSON.stringify({
						success: true,
						decision: "FINISH",
						thought:
							"The recorded Calendar result and Home navigation complete the request.",
						messageToUser: "The temporary event is absent, and Home is open.",
					}),
				);
			const events = new Set(
				outcome === "applied"
					? ["temporary-event", "untouched"]
					: ["untouched"],
			);
			let homeOpened = false;
			const executeToolCall = vi.fn(async (call: PlannerToolCall) => {
				if (call.name === "CALENDAR") {
					if (outcome === "applied")
						expect(events.delete("temporary-event")).toBe(true);
					return {
						success: true,
						transcriptVisibility: "internal" as const,
						turnComplete: false,
						data: { events: [], deleted: outcome === "applied" },
						effectReceipts: [
							{
								receiptId: "calendar-outcome-1",
								operation: `calendar.event.${outcome === "applied" ? "delete" : "search"}`,
								resource: { kind: "calendar.event", id: "temporary-event" },
								artifacts: [],
								idempotency: { key: "request-1", replayed: false },
								observedAt: "2026-09-05T10:00:00.000Z",
								...(outcome === "applied"
									? {
											outcome,
											commit: {
												kind: "durable" as const,
												id: "delete-1",
												committedAt: "2026-09-05T10:00:00.000Z",
											},
										}
									: {
											outcome,
											reason: "The search completed without a matching event.",
										}),
							},
						],
					};
				}
				expect(call.name).toBe("VIEWS");
				expect(call.params).toEqual({ action: "open", view: "home" });
				homeOpened = true;
				return {
					success: true,
					transcriptVisibility: "internal" as const,
					turnComplete: false,
					data: { openedView: "home" },
				};
			});
			const result = await runPlannerLoop({
				runtime: { useModel },
				context: {
					id: "calendar-then-home",
					events: [
						{
							id: "request",
							type: "message",
							message: {
								role: "user",
								content:
									"Check that the temporary event is absent, then open Home.",
							},
						},
					],
				},
				tools: [
					{
						name: "CALENDAR",
						description: "Inspect or remove a calendar event.",
					},
					{ name: "VIEWS", description: "Open an application view." },
				],
				executeToolCall,
			});
			expect(homeOpened).toBe(true);
			expect([...events]).toEqual(["untouched"]);
			expect(executeToolCall.mock.calls.map(([call]) => call.name)).toEqual([
				"CALENDAR",
				"VIEWS",
			]);
			expect(useModel.mock.calls.map(([type]) => type)).toEqual([
				ModelType.ACTION_PLANNER,
				ModelType.RESPONSE_HANDLER,
				ModelType.ACTION_PLANNER,
				ModelType.RESPONSE_HANDLER,
			]);
			expect(result.finalMessage).toBe(
				"The temporary event is absent, and Home is open.",
			);
			expect(result.trajectory.evaluatorOutputs[0]).toMatchObject({
				decision: "CONTINUE",
				success: false,
			});
			expect(
				result.trajectory.evaluatorOutputs[0]?.messageToUser,
			).toBeUndefined();
			expect(JSON.stringify(useModel.mock.calls[2]?.[1])).toContain(
				"calendar-outcome-1",
			);
			expect(
				result.trajectory.steps[0]?.result?.effectReceipts?.[0]?.outcome,
			).toBe(outcome);
		},
	);
});
