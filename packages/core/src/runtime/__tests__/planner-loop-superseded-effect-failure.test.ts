/**
 * Exercises failure authority through the real planner loop with scripted
 * model, tool and evaluator responses. Same-resource receipts permit changed
 * selectors; message-scoped failures retain their target and every receipt.
 */
import { describe, expect, it, vi } from "vitest";
import type { EffectReceipt } from "../../types/effects";
import { effectOperationKey, runPlannerLoop } from "../planner-loop";

const RECEIPT_BASE = {
	resource: { kind: "calendar.event", id: "evt-1" },
	artifacts: [],
	idempotency: { key: null, replayed: false },
	observedAt: "2026-09-14T06:51:00.000Z",
} as const;

function failedReceipt(operation: string): EffectReceipt {
	return {
		...RECEIPT_BASE,
		receiptId: `failed:${operation}`,
		operation,
		outcome: "failed",
		failure: {
			code: "CALENDAR_SERVICE_409",
			retryable: false,
			acceptance: "unknown",
		},
	};
}

function appliedReceipt(operation: string): EffectReceipt {
	return {
		...RECEIPT_BASE,
		receiptId: `applied:${operation}`,
		operation,
		outcome: "applied",
		commit: {
			kind: "durable",
			id: "evt-1",
			committedAt: "2026-09-14T06:51:10.000Z",
		},
	};
}

function calendarParams(
	action: "update_event" | "delete_event",
	key: string,
	target: string,
) {
	const details: Record<string, string> =
		action === "update_event" ? { start: "2026-09-18T16:00:00" } : {};
	if (key.startsWith("details."))
		details[key.substring("details.".length)] = target;
	return {
		action,
		...(key.startsWith("details.") ? {} : { [key]: target }),
		...(Object.keys(details).length ? { details } : {}),
	};
}

async function runMoveTurn(
	failedOperation: string,
	failedResourceId = "evt-1",
	failedResourceKind = "calendar.event",
	selectors?: {
		failed: string;
		applied: string;
		action: "update_event" | "delete_event";
		selectorKey?:
			| "query"
			| "eventId"
			| "title"
			| "details.eventId"
			| "details.oldTitle";
	},
	additionalFailure?: EffectReceipt,
): Promise<string> {
	const useModel = vi
		.fn()
		.mockResolvedValueOnce({
			text: "",
			toolCalls: [
				{
					id: "call-1",
					name: "CALENDAR",
					arguments: selectors
						? calendarParams(
								selectors.action,
								selectors.selectorKey ?? "query",
								selectors.failed,
							)
						: {
								action: "update_event",
								details: {
									eventId: "primary-00024",
									start: "2026-09-18T16:00:00",
								},
							},
				},
			],
		})
		.mockResolvedValueOnce({
			text: "",
			toolCalls: [
				{
					id: "call-2",
					name: "CALENDAR",
					arguments: selectors
						? calendarParams(
								selectors.action,
								selectors.selectorKey ?? "query",
								selectors.applied,
							)
						: {
								action: "update_event",
								query: "barber appointment",
								details: { start: "2026-09-18T16:00:00" },
							},
				},
			],
		})
		.mockResolvedValue({ text: "synthesized failure report" });
	const executeToolCall = vi
		.fn()
		.mockResolvedValueOnce({
			success: false,
			text: "Google Calendar is not connected.",
			effectReceipts: [
				{
					...failedReceipt(failedOperation),
					resource: { kind: failedResourceKind, id: failedResourceId },
				},
				...(additionalFailure ? [additionalFailure] : []),
			],
			data: { error: "CALENDAR_SERVICE_409" },
		})
		.mockResolvedValueOnce({
			success: true,
			text: "Updated the event.",
			effectReceipts: [
				appliedReceipt(
					selectors?.action === "delete_event"
						? "calendar.event.delete"
						: "calendar.event.update",
				),
			],
		});
	const evaluate = vi
		.fn()
		.mockResolvedValueOnce({
			success: false,
			decision: "CONTINUE" as const,
			thought: "The event id was rejected; retry by title.",
		})
		.mockResolvedValueOnce({
			success: true,
			decision: "FINISH" as const,
			thought: "The move applied.",
			messageToUser: "Moved your barber appointment to Friday at 4pm.",
		});

	const result = await runPlannerLoop({
		runtime: { useModel },
		context: { id: "ctx" },
		tools: [{ name: "CALENDAR", description: "Calendar operations." }],
		executeToolCall,
		evaluate,
	});
	expect(executeToolCall).toHaveBeenCalledTimes(2);
	const receipts = result.trajectory.steps.flatMap(
		(step) => step.result?.effectReceipts ?? [],
	);
	expect(receipts).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				outcome: "failed",
				operation: failedOperation,
			}),
			expect.objectContaining({ outcome: "applied" }),
		]),
	);
	if (additionalFailure) expect(receipts).toContainEqual(additionalFailure);
	return result.finalMessage ?? "";
}

describe("failure authority superseded by a later applied effect", () => {
	it.each([
		["update_event", "details.eventId"],
		["delete_event", "details.eventId"],
		["update_event", "details.oldTitle"],
		["delete_event", "details.oldTitle"],
		["delete_event", "title"],
	] as const)(
		"preserves supported %s selector %s across retries",
		async (action, selectorKey) => {
			await expect(
				runMoveTurn(`calendar.${action}`, "msg-1", "runtime.message", {
					failed: "Dentist",
					applied: "Barber",
					action,
					selectorKey,
				}),
			).resolves.not.toBe("Moved your barber appointment to Friday at 4pm.");
			await expect(
				runMoveTurn(`calendar.${action}`, "msg-1", "runtime.message", {
					failed: "Barber",
					applied: "Barber",
					action,
					selectorKey,
				}),
			).resolves.toBe("Moved your barber appointment to Friday at 4pm.");
		},
	);
	it("keeps a failed step when only one of its effect targets is superseded", async () => {
		await expect(
			runMoveTurn(
				"calendar.update_event",
				"msg-1",
				"runtime.message",
				{
					failed: "Barber",
					applied: "Barber",
					action: "update_event",
				},
				{
					...failedReceipt("calendar.event.update"),
					receiptId: "other-failure",
					resource: { kind: "calendar.event", id: "dentist-id" },
				},
			),
		).resolves.not.toBe("Moved your barber appointment to Friday at 4pm.");
	});
	it.each(["delete_event", "update_event"] as const)(
		"keeps different event IDs separate for a message-scoped %s failure",
		async (action) => {
			await expect(
				runMoveTurn(`calendar.${action}`, "msg-1", "runtime.message", {
					failed: "dentist-id",
					applied: "barber-id",
					action,
					selectorKey: "eventId",
				}),
			).resolves.not.toBe("Moved your barber appointment to Friday at 4pm.");
			await expect(
				runMoveTurn(`calendar.${action}`, "msg-1", "runtime.message", {
					failed: "barber-id",
					applied: "barber-id",
					action,
					selectorKey: "eventId",
				}),
			).resolves.toBe("Moved your barber appointment to Friday at 4pm.");
		},
	);
	it("does not treat empty selectors as target identity", async () => {
		await expect(
			runMoveTurn("calendar.delete_event", "msg-1", "runtime.message", {
				failed: "",
				applied: "Barber",
				action: "delete_event",
			}),
		).resolves.not.toBe("Moved your barber appointment to Friday at 4pm.");
	});
	it.each(["delete_event", "update_event"] as const)(
		"retains a message-scoped failed %s when another target succeeds",
		async (action) => {
			await expect(
				runMoveTurn(`calendar.${action}`, "msg-1", "runtime.message", {
					failed: "Dentist",
					applied: "Barber",
					action,
				}),
			).resolves.not.toBe("Moved your barber appointment to Friday at 4pm.");
		},
	);
	it.each(["delete_event", "update_event"] as const)(
		"allows a message-scoped %s retry with the same selector",
		async (action) => {
			await expect(
				runMoveTurn(`calendar.${action}`, "msg-1", "runtime.message", {
					failed: "Barber",
					applied: "Barber",
					action,
				}),
			).resolves.toBe("Moved your barber appointment to Friday at 4pm.");
		},
	);
	it("lets the applied retry's reply ship when the failed receipt names the same operation", async () => {
		await expect(runMoveTurn("calendar.event.update")).resolves.toBe(
			"Moved your barber appointment to Friday at 4pm.",
		);
	});

	it("matches the wrapper's subaction spelling of the same operation (live: calendar.update_event vs calendar.event.update)", async () => {
		await expect(runMoveTurn("calendar.update_event")).resolves.toBe(
			"Moved your barber appointment to Friday at 4pm.",
		);
	});

	it("retains a message-scoped failure when an id-to-query retry has no proof of the same target", async () => {
		await expect(
			runMoveTurn("calendar.update_event", "msg-1", "runtime.message"),
		).resolves.not.toBe("Moved your barber appointment to Friday at 4pm.");
	});

	it("keeps failure authority when the applied receipt is a different operation", async () => {
		await expect(runMoveTurn("calendar.event.delete")).resolves.not.toBe(
			"Moved your barber appointment to Friday at 4pm.",
		);
	});

	it("preserves a failed mutation of another resource", async () => {
		await expect(
			runMoveTurn("calendar.event.update", "unrelated-event"),
		).resolves.not.toBe("Moved your barber appointment to Friday at 4pm.");
	});

	it("canonicalizes only known calendar wrapper aliases", () => {
		expect(effectOperationKey("calendar.update_event")).toBe(
			effectOperationKey("calendar.event.update"),
		);
		expect(effectOperationKey("calendar.delete_event")).not.toBe(
			effectOperationKey("calendar.event.update"),
		);
		expect(effectOperationKey("trigger.create")).toBe("trigger.create");
		expect(effectOperationKey("transfer.from.to")).not.toBe(
			effectOperationKey("transfer.to.from"),
		);
	});

	it("lets a later applied mutation's reply ship over an earlier read-only lookup miss (live: TRIGGER update with a malformed taskId, then delete + create)", async () => {
		const useModel = vi
			.fn()
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "call-1",
						name: "TRIGGER",
						arguments: { action: "update", taskId: "not-a-uuid" },
					},
				],
			})
			.mockResolvedValueOnce({
				text: "",
				toolCalls: [
					{
						id: "call-2",
						name: "TRIGGER",
						arguments: {
							action: "create",
							displayName: "Email the landlord",
							scheduledAtIso: "2026-09-15T09:00:00-04:00",
						},
					},
				],
			});
		const executeToolCall = vi
			.fn()
			.mockResolvedValueOnce({
				success: false,
				text: "taskId is required.",
				error: "MISSING_TASK_ID",
				data: { actionName: "TRIGGER", op: "update", readOnlyOperation: true },
			})
			.mockResolvedValueOnce({
				success: true,
				text: 'Reminder set: "Email the landlord" — tomorrow at 9am.',
				modelReplyRequired: true,
				effectReceipts: [appliedReceipt("trigger.create")],
			});
		const evaluate = vi
			.fn()
			.mockResolvedValueOnce({
				success: false,
				decision: "CONTINUE" as const,
				thought: "The update call was malformed; create it instead.",
			})
			.mockResolvedValueOnce({
				success: true,
				decision: "FINISH" as const,
				thought: "The reminder is set.",
				messageToUser:
					"Reminder set for tomorrow at 9am to email the landlord.",
			});
		const result = await runPlannerLoop({
			runtime: { useModel },
			context: { id: "ctx" },
			tools: [{ name: "TRIGGER", description: "Trigger operations." }],
			executeToolCall,
			evaluate,
		});
		expect(executeToolCall).toHaveBeenCalledTimes(2);
		expect(result.finalMessage).toBe(
			"Reminder set for tomorrow at 9am to email the landlord.",
		);
	});
});
