/**
 * Core contract tests for durable deferred MESSAGE sends.
 *
 * These isolate the runtime port and connector boundary; the real SQL restart
 * and atomic runner claim are covered in the personal-assistant integration
 * suite that owns the ScheduledTask bridge.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { settleActionHandler } from "../../../../runtime/action-handler-settlement.ts";
import { effectDeliveryBindingProvesApplication } from "../../../../runtime/effect-delivery.ts";
import type {
	HandlerOptions,
	IAgentRuntime,
	Memory,
} from "../../../../types/index.ts";
import {
	formatSendAtIso,
	scheduleDraftSendAction,
} from "../actions/scheduleDraftSend.ts";
import { BaseMessageAdapter } from "../adapters/base.ts";
import { registerDeferredMessageScheduler } from "../deferred-send-scheduler.ts";
import {
	__resetDefaultMessageRefStoreForTests,
	MessageRefStore,
} from "../message-ref-store.ts";
import {
	__resetDefaultTriageServiceForTests,
	getDefaultTriageService,
	TriageService,
} from "../triage-service.ts";
import type {
	DraftRequest,
	ListOptions,
	MessageAdapterCapabilities,
	MessageRef,
	MessageSource,
} from "../types.ts";

function runtime(): IAgentRuntime {
	return {
		agentId: "agent-message-draft",
		logger: {
			warn: vi.fn(),
			error: vi.fn(),
			info: vi.fn(),
			debug: vi.fn(),
		},
		reportError: vi.fn(),
	} as unknown as IAgentRuntime;
}

class RecordingAdapter extends BaseMessageAdapter {
	readonly source: MessageSource = "discord";
	available = true;
	nativeSchedule = false;
	sendCount = 0;
	createCount = 0;
	scheduleCount = 0;
	failSend = false;

	isAvailable(): boolean {
		return this.available;
	}

	capabilities(): MessageAdapterCapabilities {
		return {
			list: false,
			search: false,
			manage: {},
			send: { new: true, schedule: this.nativeSchedule },
			worlds: "single",
			channels: "explicit",
		};
	}

	protected listMessagesImpl(
		_runtime: IAgentRuntime,
		_opts: ListOptions,
	): Promise<MessageRef[]> {
		return Promise.resolve([]);
	}

	protected createDraftImpl(
		_runtime: IAgentRuntime,
		draft: DraftRequest,
	): Promise<{ draftId: string; preview: string }> {
		this.createCount += 1;
		return Promise.resolve({
			draftId: `provider-draft-${this.createCount}`,
			preview: draft.body,
		});
	}

	protected async sendDraftImpl(): Promise<{ externalId: string }> {
		this.sendCount += 1;
		await Promise.resolve();
		if (this.failSend) throw new Error("provider rejected send");
		return { externalId: `provider-message-${this.sendCount}` };
	}

	protected scheduleSendImpl(): Promise<{ scheduledId: string }> {
		this.scheduleCount += 1;
		return Promise.resolve({
			scheduledId: `provider-schedule-${this.scheduleCount}`,
		});
	}
}

function draft(draftId = "draft-1") {
	return {
		draftId,
		source: "discord" as const,
		to: [{ identifier: "channel-1" }],
		body: "Pickup moved to 5:30.",
		preview: "Pickup moved to 5:30.",
		createdAtMs: Date.parse("2026-07-27T20:00:00.000Z"),
		sent: false,
		channelId: "channel-1",
	};
}

afterEach(() => {
	__resetDefaultMessageRefStoreForTests();
	__resetDefaultTriageServiceForTests();
});

describe("durable deferred MESSAGE core contract", () => {
	it("formats valid schedule timestamps as ISO-8601", () => {
		expect(formatSendAtIso(1700000000000)).toBe("2023-11-14T22:13:20.000Z");
	});

	it.each([
		["NaN", Number.NaN, "not finite"],
		["positive infinity", Number.POSITIVE_INFINITY, "not finite"],
		["negative infinity", Number.NEGATIVE_INFINITY, "not finite"],
		["out-of-range epoch", 8640000000000001, "out of Date range"],
	])(
		"rejects %s schedule timestamps with a typed error",
		(_label, value, message) => {
			expect(() => formatSendAtIso(value as number)).toThrow(
				expect.objectContaining({
					code: "MESSAGE_DRAFT_SCHEDULE_INVALID_TIME",
					message: expect.stringContaining(message as string),
				}),
			);
		},
	);

	it("rejects an invalid time before reading or scheduling a draft", async () => {
		const service = getDefaultTriageService();
		const getDraft = vi.spyOn(service.getStore(), "getDraft");
		const scheduleDraftSend = vi.spyOn(service, "scheduleDraftSend");
		const callback = vi.fn();

		await expect(
			scheduleDraftSendAction.handler(
				runtime(),
				{ content: {} } as Memory,
				undefined,
				{
					parameters: {
						draftId: "draft-1",
						sendAtMs: 8640000000000001,
					},
				} as HandlerOptions,
				callback,
			),
		).rejects.toMatchObject({
			code: "MESSAGE_DRAFT_SCHEDULE_INVALID_TIME",
		});
		expect(getDraft).not.toHaveBeenCalled();
		expect(scheduleDraftSend).not.toHaveBeenCalled();
		expect(callback).not.toHaveBeenCalled();
	});

	it("fails closed when no durable scheduler is registered", async () => {
		const rt = runtime();
		const service = new TriageService(new MessageRefStore());
		const adapter = new RecordingAdapter();
		service.register(adapter);
		service.getStore().saveDraft(draft());

		await expect(
			service.scheduleDraftSend(
				rt,
				"draft-1",
				Date.parse("2026-07-28T09:00:00.000Z"),
			),
		).rejects.toMatchObject({
			code: "DEFERRED_MESSAGE_SCHEDULER_UNAVAILABLE",
		});
	});

	it("collapses concurrent delivery attempts to one connector send", async () => {
		const rt = runtime();
		const service = new TriageService(new MessageRefStore());
		const adapter = new RecordingAdapter();
		service.register(adapter);
		service.getStore().saveDraft(draft());

		const [first, second] = await Promise.all([
			service.sendDraft(rt, "draft-1"),
			service.sendDraft(rt, "draft-1"),
		]);

		expect(adapter.sendCount).toBe(1);
		expect(first.sentExternalId).toBe("provider-message-1");
		expect(second.sentExternalId).toBe("provider-message-1");
	});

	it("recreates connector-local draft state once for concurrent persisted dispatch", async () => {
		const rt = runtime();
		const service = new TriageService(new MessageRefStore());
		const adapter = new RecordingAdapter();
		service.register(adapter);

		const [first, second] = await Promise.all([
			service.sendPersistedDraft(rt, draft("lost-on-restart")),
			service.sendPersistedDraft(rt, draft("lost-on-restart")),
		]);

		expect(adapter.createCount).toBe(1);
		expect(adapter.sendCount).toBe(1);
		expect(first).toMatchObject({
			draftId: "lost-on-restart",
			sent: true,
			sentExternalId: "provider-message-1",
		});
		expect(second.sentExternalId).toBe("provider-message-1");
	});

	it("keeps provider-native scheduling authoritative and race-safe", async () => {
		const rt = runtime();
		const service = new TriageService(new MessageRefStore());
		const adapter = new RecordingAdapter();
		adapter.nativeSchedule = true;
		service.register(adapter);
		service.getStore().saveDraft(draft());
		const durableSchedule = vi.fn();
		const unregister = registerDeferredMessageScheduler(rt, {
			schedule: durableSchedule,
		});
		const sendAtMs = Date.parse("2026-07-28T09:00:00.000Z");

		const [first, replay] = await Promise.all([
			service.scheduleDraftSend(rt, "draft-1", sendAtMs),
			service.scheduleDraftSend(rt, "draft-1", sendAtMs),
		]);
		unregister();

		expect(adapter.scheduleCount).toBe(1);
		expect(durableSchedule).not.toHaveBeenCalled();
		expect(first.scheduledId).toBe("provider-schedule-1");
		expect(first.scheduleCommit).toMatchObject({
			kind: "provider_accepted",
			id: "provider-schedule-1",
			replayed: false,
		});
		expect(replay.scheduleCommit?.replayed).toBe(true);
	});

	it("binds the scheduled-task commit receipt to the exact callback text", async () => {
		const rt = runtime();
		const service = getDefaultTriageService();
		service.register(new RecordingAdapter());
		service.getStore().saveDraft(draft());
		const sendAtMs = Date.parse("2026-07-28T09:00:00.000Z");
		const unregister = registerDeferredMessageScheduler(rt, {
			schedule: async () => ({
				scheduledId: "scheduled-task-1",
				scheduledForMs: sendAtMs,
				commit: {
					kind: "durable",
					id: "scheduled-task-1",
					committedAt: "2026-07-27T20:01:00.000Z",
					idempotencyKey:
						"message-draft-send:agent-message-draft:discord:draft-1",
					replayed: false,
				},
			}),
		});
		const callback = vi.fn(async () => []);
		const message = {
			content: { text: "Send that tomorrow morning" },
		} as Memory;
		const options = {
			parameters: {
				draftId: "draft-1",
				sendAt: new Date(sendAtMs).toISOString(),
			},
		} as HandlerOptions;

		const result = await settleActionHandler({
			runtime: rt,
			action: scheduleDraftSendAction,
			callback,
			invoke: (settledCallback) =>
				scheduleDraftSendAction.handler(
					rt,
					message,
					undefined,
					options,
					settledCallback,
				),
		});
		unregister();

		expect(result.success).toBe(true);
		expect(result.effectReceipts).toHaveLength(1);
		expect(callback).toHaveBeenCalledOnce();
		const delivered = callback.mock.calls[0]?.[0];
		expect(delivered?.effectReceiptIds).toEqual([
			"message-schedule:durable:scheduled-task-1",
		]);
		expect(
			delivered ? effectDeliveryBindingProvesApplication(delivered) : false,
		).toBe(true);
	});
});
