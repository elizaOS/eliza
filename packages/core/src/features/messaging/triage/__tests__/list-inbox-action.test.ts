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

	it("matches requested sources case-insensitively", async () => {
		getDefaultMessageRefStore().saveMessages([
			messageRef({
				id: "gmail-cased",
				externalId: "gmail-cased-external",
				snippet: "gmail hit",
				receivedAtMs: 3_000,
			}),
			messageRef({
				id: "discord-cased",
				source: "discord",
				externalId: "discord-cased-external",
				snippet: "discord miss",
				receivedAtMs: 2_000,
			}),
		]);

		const result = await listInboxAction.handler(
			createFakeRuntime(),
			messageRef({ id: "turn" }) as never,
			undefined,
			{ parameters: { sources: ["GMAIL"] } } as never,
		);

		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({ total: 1, returned: 1 });
		const casedMessages = result.data?.messages;
		expect(casedMessages).toBeDefined();
		if (!casedMessages) {
			throw new Error("Expected filtered inbox messages");
		}
		expect(
			(casedMessages as Array<{ id: string }>).map((message) => message.id),
		).toEqual(["gmail-cased"]);
	});

	it("treats unrecognized source names as no filter instead of an empty inbox", async () => {
		getDefaultMessageRefStore().saveMessages([
			messageRef({
				id: "gmail-any",
				externalId: "gmail-any-external",
				snippet: "gmail hit",
				receivedAtMs: 3_000,
			}),
			messageRef({
				id: "discord-any",
				source: "discord",
				externalId: "discord-any-external",
				snippet: "discord hit",
				receivedAtMs: 2_000,
			}),
		]);

		const result = await listInboxAction.handler(
			createFakeRuntime(),
			messageRef({ id: "turn" }) as never,
			undefined,
			{ parameters: { sources: ["carrier-pigeon"] } } as never,
		);

		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({ total: 2, returned: 2 });
	});

	it("coerces a numeric-string limit at the parameter boundary", async () => {
		getDefaultMessageRefStore().saveMessages([
			messageRef({
				id: "oldest",
				externalId: "oldest-external",
				receivedAtMs: 1_000,
			}),
			messageRef({
				id: "older",
				externalId: "older-external",
				receivedAtMs: 2_000,
			}),
			messageRef({
				id: "newer",
				externalId: "newer-external",
				receivedAtMs: 3_000,
			}),
			messageRef({
				id: "newest",
				externalId: "newest-external",
				receivedAtMs: 4_000,
			}),
		]);

		const result = await listInboxAction.handler(
			createFakeRuntime(),
			messageRef({ id: "turn" }) as never,
			undefined,
			{ parameters: { limit: "2" } } as never,
		);

		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({ total: 4, returned: 2 });
		const limitedMessages = result.data?.messages;
		expect(limitedMessages).toBeDefined();
		if (!limitedMessages) {
			throw new Error("Expected trimmed inbox messages");
		}
		expect(
			(limitedMessages as Array<{ id: string }>).map((message) => message.id),
		).toEqual(["newest", "newer"]);
	});

	it("summarizes the platform spread in the result text", async () => {
		getDefaultMessageRefStore().saveMessages([
			messageRef({
				id: "gmail-spread",
				externalId: "gmail-spread-external",
				receivedAtMs: 3_000,
			}),
			messageRef({
				id: "discord-spread",
				source: "discord",
				externalId: "discord-spread-external",
				receivedAtMs: 2_000,
			}),
		]);

		const result = await listInboxAction.handler(
			createFakeRuntime(),
			messageRef({ id: "turn" }) as never,
		);

		expect(result.success).toBe(true);
		expect(result.text).toBe(
			"2 unread message(s) across 2 platform(s); details in data.messages.",
		);
	});

	it("filters read mail out of a live pull", async () => {
		const adapter = new FixedListAdapter([
			messageRef({
				id: "live-read",
				externalId: "live-read-external",
				receivedAtMs: 9_000,
				isRead: true,
			}),
			messageRef({
				id: "live-unread-new",
				externalId: "live-unread-new-external",
				receivedAtMs: 8_000,
			}),
			messageRef({
				id: "live-unread-old",
				externalId: "live-unread-old-external",
				receivedAtMs: 7_000,
			}),
		]);
		await registerAdapter(adapter);

		const result = await listInboxAction.handler(
			createFakeRuntime(),
			messageRef({ id: "turn" }) as never,
		);

		expect(result.success).toBe(true);
		expect(result.data).toMatchObject({ total: 2, returned: 2 });
		const liveMessages = result.data?.messages;
		expect(liveMessages).toBeDefined();
		if (!liveMessages) {
			throw new Error("Expected live-pull inbox messages");
		}
		expect(
			(liveMessages as Array<{ id: string }>).map((message) => message.id),
		).toEqual(["live-unread-new", "live-unread-old"]);
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
