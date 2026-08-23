/**
 * Exercises the MESSAGE search action through the real in-process TriageService
 * with deterministic connector adapters. The suite covers routing validation,
 * merged result projection, partial source coverage, and every cap-evidence
 * state without a live connector, model, or database.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
} from "../../../../types/index.ts";
import { createFakeRuntime } from "../__tests__/fake-runtime.ts";
import { BaseMessageAdapter } from "../adapters/base.ts";
import { __resetDefaultMessageRefStoreForTests } from "../message-ref-store.ts";
import {
	__resetDefaultTriageServiceForTests,
	getDefaultTriageService,
} from "../triage-service.ts";
import type { ListOptions, MessageRef, MessageSource } from "../types.ts";
import { searchMessagesAction } from "./searchMessages.ts";

function messageRef(
	source: MessageSource,
	id: string,
	overrides: Partial<MessageRef> = {},
): MessageRef {
	return {
		id,
		source,
		externalId: `external-${id}`,
		from: { identifier: "alice@example.com", displayName: "Alice Example" },
		to: [{ identifier: "owner@example.com" }],
		snippet: "Quarterly launch update",
		receivedAtMs: 1_000,
		hasAttachments: false,
		isRead: false,
		...overrides,
	};
}

class SearchAdapter extends BaseMessageAdapter {
	readonly seenLimits: Array<number | undefined> = [];

	constructor(
		readonly source: MessageSource,
		private readonly messages: MessageRef[],
		private readonly available = true,
		private readonly failure?: Error,
	) {
		super();
	}

	isAvailable(): boolean {
		return this.available;
	}

	protected async listMessagesImpl(
		_runtime: IAgentRuntime,
		opts: ListOptions,
	): Promise<MessageRef[]> {
		this.seenLimits.push(opts.limit);
		if (this.failure) throw this.failure;
		return this.messages;
	}
}

function options(parameters: Record<string, unknown>): HandlerOptions {
	return { parameters } as HandlerOptions;
}

async function runSearch(parameters: Record<string, unknown> = {}) {
	return searchMessagesAction.handler(
		createFakeRuntime(),
		{ content: { text: "search my messages" } } as Memory,
		undefined,
		options(parameters),
	);
}

describe("searchMessagesAction", () => {
	beforeEach(() => {
		__resetDefaultMessageRefStoreForTests();
		__resetDefaultTriageServiceForTests();
	});

	afterEach(() => {
		__resetDefaultTriageServiceForTests();
		__resetDefaultMessageRefStoreForTests();
	});

	it("exposes the read-only MESSAGE contract and validates routed contexts", async () => {
		expect(searchMessagesAction).toMatchObject({
			name: "MESSAGE",
			contexts: ["messaging", "email", "documents"],
			roleGate: { minRole: "ADMIN" },
		});

		const message = { content: { text: "find Alice's email" } } as Memory;
		const emailState = {
			values: { __contextRouting: { primaryContext: "email" } },
		} as unknown as State;
		const generalState = {
			values: { __contextRouting: { primaryContext: "general" } },
		} as unknown as State;

		await expect(
			searchMessagesAction.validate(createFakeRuntime(), message, emailState),
		).resolves.toBe(true);
		await expect(
			searchMessagesAction.validate(createFakeRuntime(), message, generalState),
		).resolves.toBe(false);
	});

	it("returns the newest filtered hit with truthful overflow and source gaps", async () => {
		const gmail = new SearchAdapter("gmail", [
			messageRef("gmail", "older", {
				worldId: "work",
				channelId: "inbox",
				tags: ["launch", "important"],
				receivedAtMs: 2_000,
				triageScore: {
					contactWeight: 0.5,
					userRepliedInThread: false,
					scoredAt: 5_000,
				},
			}),
			messageRef("gmail", "newer", {
				worldId: "work",
				channelId: "inbox",
				tags: ["launch", "important"],
				receivedAtMs: 3_000,
				subject: "Launch plan",
			}),
			messageRef("gmail", "filtered-out", {
				from: { identifier: "bob@example.com", displayName: "Bob" },
			}),
		]);
		const service = getDefaultTriageService();
		service.register(gmail);
		service.register(new SearchAdapter("discord", [], false));
		service.register(
			new SearchAdapter("telegram", [], true, new Error("connector failed")),
		);

		const result = await runSearch({
			sources: ["gmail", "discord", "telegram", "whatsapp"],
			worldIds: ["work"],
			channelIds: ["inbox"],
			sender: "alice@example.com",
			content: "launch",
			tags: ["launch", "important"],
			since: 1_500,
			until: 3_500,
			limit: 1,
		});

		expect(gmail.seenLimits).toEqual([2]);
		expect(result.success).toBe(true);
		expect(result.text).toBe(
			"Found 1 match(es) from 1 source(s). Searched 1 of 4 requested source(s); not searched: whatsapp (not registered), discord (unavailable), telegram (failed). More matches were returned by the measured limit+1 probe beyond the 1 shown.",
		);
		expect(result.data).toEqual({
			count: 1,
			scope: {
				requestedSources: ["gmail", "discord", "telegram", "whatsapp"],
				succeededSources: ["gmail"],
				unregisteredSources: ["whatsapp"],
				unavailableSources: ["discord"],
				failedSources: ["telegram"],
				filtersApplied: {
					worldIds: true,
					channelIds: true,
					sender: true,
					content: true,
					tags: true,
					since: true,
					until: true,
				},
				limit: 1,
				hasMore: true,
				retrievalCompleteness: "unknown_beyond_connector_windows",
			},
			messages: [
				{
					id: "newer",
					source: "gmail",
					worldId: "work",
					channelId: "inbox",
					from: "alice@example.com",
					subject: "Launch plan",
					snippet: "Quarterly launch update",
					receivedAtMs: 3_000,
					tags: ["launch", "important"],
					contactWeight: null,
				},
			],
		});
	});

	it("distinguishes exact-fit and uncapped searches", async () => {
		const service = getDefaultTriageService();
		service.register(
			new SearchAdapter("gmail", [messageRef("gmail", "gmail-hit")]),
		);
		service.register(
			new SearchAdapter("discord", [
				messageRef("discord", "discord-hit", { receivedAtMs: 2_000 }),
			]),
		);

		const exactFit = await runSearch({
			sources: ["gmail", "discord"],
			limit: 2,
		});
		expect(exactFit.text).toBe(
			"Found 2 match(es) from 2 source(s). Searched 2 of 2 requested source(s). The measured limit+1 probe returned no match beyond the 2 shown; connector-internal completeness is unknown.",
		);
		const exactFitMessages = exactFit.data?.messages;
		if (!exactFitMessages) throw new Error("Expected exact-fit messages");
		expect(
			(exactFitMessages as Array<{ id: string }>).map(({ id }) => id),
		).toEqual(["discord-hit", "gmail-hit"]);
		expect(exactFit.data?.scope).toMatchObject({
			limit: 2,
			hasMore: false,
			filtersApplied: {
				worldIds: false,
				channelIds: false,
				sender: false,
				content: false,
				tags: false,
				since: false,
				until: false,
			},
		});

		__resetDefaultTriageServiceForTests();
		const uncapped = await runSearch({ sources: ["whatsapp"] });
		expect(uncapped.text).toBe(
			"No matching messages were returned. Searched 0 of 1 requested source(s); not searched: whatsapp (not registered). No result cap was probed; connector-internal completeness is unknown.",
		);
		expect(uncapped.data).toMatchObject({
			count: 0,
			scope: { limit: null, hasMore: null },
			messages: [],
		});
	});

	it("propagates an all-failed connector search", async () => {
		getDefaultTriageService().register(
			new SearchAdapter("gmail", [], true, new Error("gmail unavailable")),
		);

		await expect(runSearch({ sources: ["gmail"] })).rejects.toThrow(
			"gmail unavailable",
		);
	});
});
