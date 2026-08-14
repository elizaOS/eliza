/**
 * Pins the scope-disclosure contract of the two read-only triage actions:
 * listInbox and searchMessages must name what narrowed their result (requested
 * sources against the registered ones, time window, limit) instead of asserting
 * full coverage of "connected platforms"/"connected channels". Deterministic —
 * a real TriageService with a locally registered stub adapter, the in-process
 * message-ref store, and the fake runtime; no live model, connector, or DB.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { IAgentRuntime } from "../../../../types/index.ts";
import { listInboxAction } from "../actions/listInbox.ts";
import { searchMessagesAction } from "../actions/searchMessages.ts";
import { BaseMessageAdapter } from "../adapters/base.ts";
import {
	__resetDefaultMessageRefStoreForTests,
	getDefaultMessageRefStore,
} from "../message-ref-store.ts";
import {
	__resetDefaultTriageServiceForTests,
	getDefaultTriageService,
} from "../triage-service.ts";
import type { ListOptions, MessageRef, MessageSource } from "../types.ts";
import { createFakeRuntime } from "./fake-runtime.ts";

function messageRef(overrides: Partial<MessageRef>): MessageRef {
	return {
		id: "msg",
		source: "discord",
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

/** Stands in for a connector plugin's adapter: available, list-backed. */
class StubDiscordAdapter extends BaseMessageAdapter {
	readonly source: MessageSource = "discord";

	isAvailable(runtime: IAgentRuntime): boolean {
		return runtime.getService("discord") != null;
	}

	protected async listMessagesImpl(
		_runtime: IAgentRuntime,
		_opts: ListOptions,
	): Promise<MessageRef[]> {
		return [
			messageRef({ id: "discord-1", externalId: "1", receivedAtMs: 2_000 }),
			messageRef({ id: "discord-2", externalId: "2", receivedAtMs: 1_000 }),
		];
	}
}

const runtimeWithDiscord = (): IAgentRuntime =>
	createFakeRuntime({ availableServices: new Set(["discord"]) });

describe("triage read actions disclose their scope", () => {
	beforeEach(() => {
		__resetDefaultTriageServiceForTests();
		__resetDefaultMessageRefStoreForTests();
		getDefaultTriageService().register(new StubDiscordAdapter());
	});

	afterEach(() => {
		__resetDefaultTriageServiceForTests();
		__resetDefaultMessageRefStoreForTests();
	});

	it("names the source filter when a scoped inbox check comes back empty", async () => {
		// Unread mail exists — in a source the request filtered away.
		getDefaultMessageRefStore().saveMessages([
			messageRef({ id: "discord-1", externalId: "1" }),
		]);

		const result = await listInboxAction.handler(
			runtimeWithDiscord(),
			messageRef({ id: "turn" }) as never,
			undefined,
			{ parameters: { sources: ["gmail"] } } as never,
		);

		expect(result.success).toBe(true);
		// The old text claimed the whole inbox across every connected platform.
		expect(result.text).not.toBe(
			"No unread messages across connected platforms.",
		);
		expect(result.text).toContain("sources=gmail");
		expect(result.text).toContain("1 connected");
		expect(result.text).toContain("drop the filters");
	});

	it("names the limit and the shown count when unread messages are trimmed", async () => {
		getDefaultMessageRefStore().saveMessages([
			messageRef({ id: "discord-1", externalId: "1", receivedAtMs: 3_000 }),
			messageRef({ id: "discord-2", externalId: "2", receivedAtMs: 2_000 }),
		]);

		const result = await listInboxAction.handler(
			runtimeWithDiscord(),
			messageRef({ id: "turn" }) as never,
			undefined,
			{ parameters: { sources: ["discord"], limit: 1 } } as never,
		);

		expect(result.data).toMatchObject({ total: 2, returned: 1 });
		expect(result.text).toContain("limit 1");
		expect(result.text).toContain("showing 1");
	});

	it("names the source and time filters when a search comes back empty", async () => {
		const result = await searchMessagesAction.handler(
			runtimeWithDiscord(),
			messageRef({ id: "turn" }) as never,
			undefined,
			{
				parameters: { sources: ["gmail"], since: 5_000, content: "launch" },
			} as never,
		);

		expect(result.success).toBe(true);
		expect(result.text).not.toBe(
			"No matching messages found across connected channels.",
		);
		expect(result.text).toContain("sources=gmail");
		expect(result.text).toContain("a content keyword");
		expect(result.text).toContain("since ");
		// The keyword itself is named, never echoed.
		expect(result.text).not.toContain("launch");
	});

	it("says the result limit was reached instead of reporting it as the total", async () => {
		const result = await searchMessagesAction.handler(
			runtimeWithDiscord(),
			messageRef({ id: "turn" }) as never,
			undefined,
			{ parameters: { limit: 1 } } as never,
		);

		expect((result.data as { count: number }).count).toBe(1);
		expect(result.text).toContain("limit 1");
		expect(result.text).toContain("limit was reached");
	});
});
