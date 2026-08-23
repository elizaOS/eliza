/**
 * Exercises the deferred-send MESSAGE action through the real default
 * TriageService and its in-memory store. An in-process adapter and scheduler
 * provide the connector boundaries while the suite covers action validation,
 * input rejection, receipt projection, callback delivery, and fail-closed
 * handling of an invalid scheduler result.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
	Content,
	HandlerCallback,
	HandlerOptions,
	Memory,
	State,
} from "../../../../types/index.ts";
import { createFakeRuntime } from "../__tests__/fake-runtime.ts";
import { BaseMessageAdapter } from "../adapters/base.ts";
import {
	type DeferredMessageScheduler,
	registerDeferredMessageScheduler,
} from "../deferred-send-scheduler.ts";
import { __resetDefaultMessageRefStoreForTests } from "../message-ref-store.ts";
import {
	__resetDefaultTriageServiceForTests,
	getDefaultTriageService,
} from "../triage-service.ts";
import type { MessageSource } from "../types.ts";
import { scheduleDraftSendAction } from "./scheduleDraftSend.ts";

class AvailableAdapter extends BaseMessageAdapter {
	readonly source: MessageSource = "gmail";

	isAvailable(): boolean {
		return true;
	}
}

const message = { content: { text: "Send the draft tomorrow" } } as Memory;
const sendAtMs = Date.parse("2026-08-24T09:30:00.000Z");

function options(parameters: Record<string, unknown>): HandlerOptions {
	return { parameters } as HandlerOptions;
}

function stateFor(primaryContext: string): State {
	return {
		values: { __contextRouting: { primaryContext } },
		data: {},
		text: "",
	};
}

function saveDraft(): void {
	getDefaultTriageService()
		.getStore()
		.saveDraft({
			draftId: "draft-1",
			source: "gmail",
			to: [{ identifier: "alice@example.com" }],
			body: "The release is ready.",
			preview: "The release is ready.",
			createdAtMs: Date.parse("2026-08-23T12:00:00.000Z"),
			sent: false,
		});
}

describe("scheduleDraftSendAction", () => {
	beforeEach(() => {
		__resetDefaultMessageRefStoreForTests();
		__resetDefaultTriageServiceForTests();
	});

	afterEach(() => {
		__resetDefaultTriageServiceForTests();
		__resetDefaultMessageRefStoreForTests();
	});

	it("is eligible only in a supported messaging context", async () => {
		await expect(
			scheduleDraftSendAction.validate?.(
				createFakeRuntime(),
				message,
				stateFor("automation"),
			),
		).resolves.toBe(true);
		await expect(
			scheduleDraftSendAction.validate?.(
				createFakeRuntime(),
				message,
				stateFor("payments"),
			),
		).resolves.toBe(false);
	});

	it.each([
		[{}, "draftId is required"],
		[
			{ draftId: "draft-1" },
			"sendAtMs (number) or sendAt (ISO string) is required",
		],
	])(
		"rejects invalid parameters before consulting the draft store",
		async (parameters, error) => {
			const result = await scheduleDraftSendAction.handler(
				createFakeRuntime(),
				message,
				undefined,
				options(parameters),
			);

			expect(result).toEqual({ success: false, text: error, error });
		},
	);

	it("returns an explicit failure when the requested draft is missing", async () => {
		const result = await scheduleDraftSendAction.handler(
			createFakeRuntime(),
			message,
			undefined,
			options({ draftId: "missing-draft", sendAtMs }),
		);

		expect(result).toEqual({
			success: false,
			text: "No draft found for id missing-draft",
			error: "No draft found for id missing-draft",
		});
	});

	it("projects the durable commit into a verified receipt and callback", async () => {
		const runtime = createFakeRuntime();
		getDefaultTriageService().register(new AvailableAdapter());
		saveDraft();
		const unregister = registerDeferredMessageScheduler(runtime, {
			schedule: async ({ draft, sendAtMs: requestedAt }) => ({
				scheduledId: "scheduled-task-1",
				scheduledForMs: requestedAt,
				commit: {
					kind: "durable",
					id: "scheduled-task-1",
					committedAt: "2026-08-23T12:01:00.000Z",
					idempotencyKey: `message-draft-send:${draft.draftId}`,
					replayed: false,
				},
			}),
		});
		const delivered: Content[] = [];
		const callback: HandlerCallback = async (content) => {
			delivered.push(content);
			return [];
		};

		const result = await scheduleDraftSendAction.handler(
			runtime,
			message,
			undefined,
			options({ draftId: "draft-1", sendAt: "2026-08-24T09:30:00.000Z" }),
			callback,
		);
		unregister();

		const text = "Scheduled draft draft-1 for 2026-08-24T09:30:00.000Z.";
		expect(delivered).toEqual([{ text, action: "MESSAGE" }]);
		expect(result).toMatchObject({
			success: true,
			text,
			verifiedUserFacing: true,
			userFacingText: text,
			userFacingEffectReceiptIds: ["message-schedule:durable:scheduled-task-1"],
			data: {
				draftId: "draft-1",
				source: "gmail",
				scheduledForMs: sendAtMs,
				scheduledId: "scheduled-task-1",
			},
		});
		expect(result.effectReceipts).toEqual([
			expect.objectContaining({
				receiptId: "message-schedule:durable:scheduled-task-1",
				operation: "message.draft.schedule",
				resource: {
					kind: "messaging.deferred_send",
					id: "scheduled-task-1",
				},
				artifacts: [{ kind: "messaging.draft", id: "draft-1" }],
				idempotency: {
					key: "message-draft-send:draft-1",
					replayed: false,
				},
				outcome: "applied",
				commit: {
					kind: "durable",
					id: "scheduled-task-1",
					committedAt: "2026-08-23T12:01:00.000Z",
				},
			}),
		]);
	});

	it("succeeds without a callback and preserves the scheduler's projected time", async () => {
		const runtime = createFakeRuntime();
		getDefaultTriageService().register(new AvailableAdapter());
		saveDraft();
		const projectedAt = sendAtMs + 1_000;
		const unregister = registerDeferredMessageScheduler(runtime, {
			schedule: async () => ({
				scheduledId: "scheduled-task-2",
				scheduledForMs: projectedAt,
				commit: {
					kind: "durable",
					id: "scheduled-task-2",
					committedAt: "2026-08-23T12:02:00.000Z",
					idempotencyKey: "message-draft-send:draft-1",
					replayed: false,
				},
			}),
		});

		const result = await scheduleDraftSendAction.handler(
			runtime,
			message,
			undefined,
			options({ draftId: "draft-1", sendAtMs }),
		);
		unregister();

		expect(result.success).toBe(true);
		expect(result.data?.scheduledForMs).toBe(projectedAt);
	});

	it("fails closed when the scheduler returns no commit proof", async () => {
		const runtime = createFakeRuntime();
		getDefaultTriageService().register(new AvailableAdapter());
		saveDraft();
		const invalidScheduler = {
			schedule: async () => ({
				scheduledId: "unproven-schedule",
				scheduledForMs: sendAtMs,
				commit: undefined,
			}),
		} as unknown as DeferredMessageScheduler;
		const unregister = registerDeferredMessageScheduler(
			runtime,
			invalidScheduler,
		);

		await expect(
			scheduleDraftSendAction.handler(
				runtime,
				message,
				undefined,
				options({ draftId: "draft-1", sendAtMs }),
			),
		).rejects.toMatchObject({
			code: "MESSAGE_DRAFT_SCHEDULE_RECEIPT_MISSING",
		});
		unregister();
	});
});
