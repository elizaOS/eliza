/**
 * Exercises listInboxAction against a fake runtime and the in-process default
 * message-ref store: seeds cached refs of mixed sources, then asserts the
 * handler filters unread messages down to the requested sources. Deterministic
 * — no live model, no connector, no real DB.
 */

import { beforeEach, describe, expect, it } from "vitest";

import type { IAgentRuntime } from "../../../../types/index.ts";
import { CONTEXT_ROUTING_STATE_KEY } from "../../../../utils/context-routing.ts";
import { listInboxAction } from "../actions/listInbox.ts";
import { BaseMessageAdapter } from "../adapters/base.ts";
import {
	__resetDefaultMessageRefStoreForTests,
	getDefaultMessageRefStore,
} from "../message-ref-store.ts";
import { __resetDefaultTriageServiceForTests } from "../triage-service.ts";
import type { MessageRef } from "../types.ts";
import { createFakeRuntime } from "./fake-runtime.ts";

function messageRef(overrides: Partial<MessageRef>): MessageRef {
	return {
		id: "msg",
		source: "gmail",
		externalId: "external-msg",
		from: { identifier: "alice@example.com" },
		to: [{ identifier: "owner@example.com" }],
		snippet: "hello",
		receivedAtMs: 1_000,
		hasAttachments: false,
		isRead: false,
		...overrides,
	};
}

class FixedListAdapter extends BaseMessageAdapter {
	readonly source = "gmail" as const;
	readonly seenOptions: Parameters<BaseMessageAdapter["listMessages"]>[1][] =
		[];

	constructor(
		private readonly refs: MessageRef[],
		private readonly failure?: unknown,
	) {
		super();
	}

	isAvailable(): boolean {
		return true;
	}

	protected override async listMessagesImpl(
		_runtime: IAgentRuntime,
		opts: Parameters<BaseMessageAdapter["listMessages"]>[1],
	): Promise<MessageRef[]> {
		this.seenOptions.push(opts);
		if (this.failure !== undefined) {
			throw this.failure;
		}
		return this.refs;
	}
}

async function registerAdapter(adapter: BaseMessageAdapter): Promise<void> {
	const { getDefaultTriageService } = await import("../triage-service.ts");
	getDefaultTriageService().register(adapter);
}

describe("listInboxAction", () => {
	beforeEach(() => {
		__resetDefaultMessageRefStoreForTests();
		__resetDefaultTriageServiceForTests();
	});

	it("filters cached unread messages to the requested sources", async () => {
		getDefaultMessageRefStore().saveMessages([
			messageRef({
				id: "gmail-1",
				source: "gmail",
				externalId: "gmail-external-1",
				snippet: "gmail hit",
				receivedAtMs: 3_000,
			}),
			messageRef({
				id: "discord-1",
				source: "discord",
				externalId: "discord-external-1",
				snippet: "discord miss",
				receivedAtMs: 2_000,
			}),
			messageRef({
				id: "whatsapp-1",
				source: "whatsapp",
				externalId: "whatsapp-external-1",
				snippet: "WhatsApp hit",
			}),
		]);

		const result = await listInboxAction.handler(
			createFakeRuntime(),
			messageRef({ id: "turn", source: "gmail" }) as never,
			undefined,
			{ parameters: { sources: ["gmail", "whatsapp"] } } as never,
		);

		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({ total: 2, returned: 2 });
		const messages = result.data?.messages;
		expect(messages).toBeDefined();
		if (!messages) {
			throw new Error("Expected aggregated inbox messages");
		}
		expect(
			(messages as Array<{ id: string }>).map((message) => message.id),
		).toEqual(["gmail-1", "whatsapp-1"]);
	});

	it("validates messaging contexts and rejects unrelated contexts", async () => {
		const message = { content: { text: "show inbox" } } as never;
		const runtime = createFakeRuntime();

		expect(
			await listInboxAction.validate(runtime, message, {
				values: {
					[CONTEXT_ROUTING_STATE_KEY]: { primaryContext: "email" },
				},
			} as never),
		).toBe(true);
		expect(
			await listInboxAction.validate(runtime, message, {
				values: {
					[CONTEXT_ROUTING_STATE_KEY]: { primaryContext: "wallet" },
				},
			} as never),
		).toBe(false);
	});

	it("ranks cached messages, preserves equal-score ties, filters read mail, and applies the limit", async () => {
		getDefaultMessageRefStore().saveMessages([
			messageRef({
				id: "read-newest",
				receivedAtMs: 9_000,
				isRead: true,
			}),
			messageRef({
				id: "equal-first",
				receivedAtMs: 5_000,
			}),
			messageRef({
				id: "tie-winner",
				receivedAtMs: 5_000,
				subject: "Important relationship",
				triageScore: {
					contactWeight: 0.9,
					userRepliedInThread: true,
					scoredAt: 5_001,
				},
			}),
			messageRef({
				id: "equal-second",
				receivedAtMs: 5_000,
			}),
			messageRef({
				id: "older",
				receivedAtMs: 4_000,
			}),
		]);

		const result = await listInboxAction.handler(
			createFakeRuntime(),
			messageRef({ id: "turn" }) as never,
			undefined,
			{ parameters: { limit: 3 } } as never,
		);

		expect(result.success).toBe(true);
		expect(result.text).toBe(
			"4 unread message(s) across 1 platform(s); details in data.messages.",
		);
		expect(result.data).toEqual({
			total: 4,
			returned: 3,
			messages: [
				{
					id: "tie-winner",
					source: "gmail",
					from: "alice@example.com",
					subject: "Important relationship",
					snippet: "hello",
					receivedAtMs: 5_000,
					contactWeight: 0.9,
					userRepliedInThread: true,
				},
				{
					id: "equal-first",
					source: "gmail",
					from: "alice@example.com",
					subject: null,
					snippet: "hello",
					receivedAtMs: 5_000,
					contactWeight: null,
					userRepliedInThread: null,
				},
				{
					id: "equal-second",
					source: "gmail",
					from: "alice@example.com",
					subject: null,
					snippet: "hello",
					receivedAtMs: 5_000,
					contactWeight: null,
					userRepliedInThread: null,
				},
			],
		});
	});

	it("pulls and scores live adapter messages when the cache is empty", async () => {
		const adapter = new FixedListAdapter([
			messageRef({
				id: "live-message",
				externalId: "live-external",
				receivedAtMs: 7_000,
			}),
		]);
		await registerAdapter(adapter);

		const result = await listInboxAction.handler(
			createFakeRuntime(),
			messageRef({ id: "turn" }) as never,
			undefined,
			{
				parameters: { sources: ["gmail"], sinceMs: 6_000, limit: 10 },
			} as never,
		);

		expect(adapter.seenOptions).toHaveLength(1);
		expect(adapter.seenOptions[0]).toMatchObject({
			sinceMs: 6_000,
			limit: 10,
		});
		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({
			total: 1,
			returned: 1,
			messages: [
				{
					id: "live-message",
					contactWeight: 0.5,
					userRepliedInThread: false,
				},
			],
		});
	});

	it("returns the explicit empty-inbox result when no source has messages", async () => {
		const result = await listInboxAction.handler(
			createFakeRuntime(),
			messageRef({ id: "turn" }) as never,
		);

		expect(result).toMatchObject({
			success: true,
			text: "No unread messages across connected platforms.",
			data: { total: 0, returned: 0, messages: [] },
		});
	});

	it("translates adapter errors into a failed action result", async () => {
		await registerAdapter(
			new FixedListAdapter([], new Error("gmail unavailable")),
		);

		const result = await listInboxAction.handler(
			createFakeRuntime(),
			messageRef({ id: "turn" }) as never,
		);

		expect(result).toEqual({
			success: false,
			text: "Failed to list inbox: gmail unavailable",
			error: "gmail unavailable",
			data: { actionName: "MESSAGE" },
		});
	});

	it("stringifies non-Error failures at the action boundary", async () => {
		await registerAdapter(new FixedListAdapter([], "connector refused"));

		const result = await listInboxAction.handler(
			createFakeRuntime(),
			messageRef({ id: "turn" }) as never,
		);

		expect(result).toEqual({
			success: false,
			text: "Failed to list inbox: connector refused",
			error: "connector refused",
			data: { actionName: "MESSAGE" },
		});
	});
});
