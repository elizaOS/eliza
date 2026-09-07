/**
 * Real planner loop, evaluator, action settlement, and result mapping. Only
 * model responses and the committed in-memory mutation are fixtures. A failed
 * presentation after an internal applied effect must not replay the request.
 */
import { describe, expect, it, vi } from "vitest";
import { NoModelProviderConfiguredError } from "../../runtime";
import { subPlannerResultToPlannerToolResult } from "../../services/message";
import type { Action, IAgentRuntime } from "../../types";
import { ModelType } from "../../types/model";
import { settleActionHandler } from "../action-handler-settlement";
import {
	actionResultToPlannerToolResult,
	runPlannerLoop,
} from "../planner-loop";
import type { PlannerRuntime, PlannerToolCall } from "../planner-types";

const receipt = {
	receiptId: "receipt-calendar-delete-1",
	operation: "calendar.event.delete",
	resource: { kind: "calendar.event", id: "event-1" },
	artifacts: [],
	idempotency: { key: "request-1", replayed: false },
	observedAt: "2026-09-05T10:00:00.000Z",
	outcome: "applied" as const,
	commit: {
		kind: "durable" as const,
		id: "delete-1",
		committedAt: "2026-09-05T10:00:00.000Z",
	},
};

describe("internal applied effect followed by evaluator reply failure", () => {
	it.each([
		{
			label: "HTTP 429",
			kind: "rate_limited",
			error: () => Object.assign(new Error("Rate limit"), { statusCode: 429 }),
		},
		{
			label: "HTTP 503",
			kind: "provider_issue",
			error: () => Object.assign(new Error("Unavailable"), { statusCode: 503 }),
		},
		{
			label: "no provider",
			kind: "no_provider",
			error: () => new NoModelProviderConfiguredError(),
		},
	])(
		"preserves receipt and stops replay after $label",
		async ({ kind, error }) => {
			const events = new Set(["event-1", "untouched-event"]);
			const callback = vi.fn(async () => []);
			const useModel = vi
				.fn<PlannerRuntime["useModel"]>()
				.mockResolvedValueOnce({
					text: "",
					toolCalls: [
						{
							id: "delete-1",
							name: "CALENDAR",
							arguments: { action: "delete_event", eventId: "event-1" },
						},
						{ id: "later-1", name: "LATER", arguments: {} },
					],
				})
				.mockRejectedValueOnce(error());
			const runtime = {
				useModel,
				logger: {
					debug: vi.fn(),
					info: vi.fn(),
					warn: vi.fn(),
					error: vi.fn(),
				},
				reportError: vi.fn(),
			} as unknown as IAgentRuntime;
			const executeToolCall = vi.fn(async (call: PlannerToolCall) => {
				expect(call.name).toBe("CALENDAR");
				return actionResultToPlannerToolResult(
					await settleActionHandler({
						runtime,
						action: { name: "CALENDAR", tags: ["write"] } as Action,
						callback,
						invoke: async () => {
							expect(events.delete(String(call.params?.eventId))).toBe(true);
							return {
								success: true,
								transcriptVisibility: "internal",
								turnComplete: false,
								effectReceipts: [receipt],
								data: {
									deleted: true,
									replyContext: {
										scenario: "delete_event_completed",
										facts: "The selected event was deleted.",
									},
								},
							};
						},
					}),
				);
			});

			const result = await runPlannerLoop({
				runtime,
				context: { id: "internal-calendar-effect" },
				tools: [
					{ name: "CALENDAR", description: "Delete the selected event." },
					{ name: "LATER", description: "A later operation." },
				],
				executeToolCall,
			});

			expect([...events]).toEqual(["untouched-event"]);
			expect(executeToolCall).toHaveBeenCalledTimes(1);
			expect(useModel.mock.calls.map(([type]) => type)).toEqual([
				ModelType.ACTION_PLANNER,
				ModelType.RESPONSE_HANDLER,
			]);
			expect(JSON.stringify(useModel.mock.calls[1]?.[1])).toContain(
				receipt.receiptId,
			);
			expect(callback).not.toHaveBeenCalled();
			expect(result.status).toBe("finished");
			expect(result.finalMessage).toBeUndefined();
			expect(result.terminalFailure).toMatchObject({ kind, transient: false });
			expect(result.terminalFailure?.message).toBeTruthy();
			expect(result.trajectory.steps).toHaveLength(1);
			expect(result.trajectory.steps[0]?.result).toMatchObject({
				success: true,
				transcriptVisibility: "internal",
				turnComplete: false,
				effectReceipts: [receipt],
				data: { deleted: true },
				replyFailure: result.terminalFailure,
			});
			expect(subPlannerResultToPlannerToolResult(result)).toMatchObject({
				success: true,
				effectReceipts: [receipt],
				replyFailure: result.terminalFailure,
			});
			expect(result.trajectory.steps[0]?.result?.error).toBeUndefined();
			expect(result.trajectory.plannedQueue).toMatchObject([
				{ id: "later-1", name: "LATER" },
			]);
		},
	);
});
