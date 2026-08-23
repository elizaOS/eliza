/**
 * Exercises the MESSAGE triage action through the real default TriageService
 * and deterministic in-process adapters. The suite covers context eligibility,
 * empty scans, parameter forwarding, cross-source ranking and ties, result
 * projection, and connector failures without live integrations.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
	HandlerOptions,
	IAgentRuntime,
	Memory,
	State,
	UUID,
} from "../../../../types/index.ts";
import { CONTEXT_ROUTING_STATE_KEY } from "../../../../utils/context-routing.ts";
import { createFakeRuntime, fakeContact } from "../__tests__/fake-runtime.ts";
import { BaseMessageAdapter } from "../adapters/base.ts";
import { __resetDefaultMessageRefStoreForTests } from "../message-ref-store.ts";
import {
	__resetDefaultTriageServiceForTests,
	getDefaultTriageService,
} from "../triage-service.ts";
import type { ListOptions, MessageRef, MessageSource } from "../types.ts";
import { triageMessagesAction } from "./triageMessages.ts";

function messageRef(overrides: Partial<MessageRef> = {}): MessageRef {
	return {
		id: "message-1",
		source: "gmail",
		externalId: "external-message-1",
		from: { identifier: "sender@example.com" },
		to: [{ identifier: "owner@example.com" }],
		snippet: "Message preview",
		receivedAtMs: 1_000,
		hasAttachments: false,
		isRead: false,
		...overrides,
	};
}

class RecordingListAdapter extends BaseMessageAdapter {
	readonly seenOptions: ListOptions[] = [];

	constructor(
		readonly source: MessageSource,
		private readonly messages: MessageRef[] = [],
		private readonly failure?: Error,
	) {
		super();
	}

	isAvailable(): boolean {
		return true;
	}

	protected override listMessagesImpl(
		_runtime: IAgentRuntime,
		opts: ListOptions,
	): Promise<MessageRef[]> {
		this.seenOptions.push(opts);
		if (this.failure) {
			return Promise.reject(this.failure);
		}
		return Promise.resolve(this.messages);
	}
}

const turn = { content: { text: "Triage my messages" } } as Memory;

function stateFor(primaryContext: string): State {
	return {
		values: { [CONTEXT_ROUTING_STATE_KEY]: { primaryContext } },
		data: {},
		text: "",
	};
}

function options(parameters: Record<string, unknown>): HandlerOptions {
	return { parameters } as HandlerOptions;
}

describe("triageMessagesAction", () => {
	beforeEach(() => {
		__resetDefaultMessageRefStoreForTests();
		__resetDefaultTriageServiceForTests();
	});

	afterEach(() => {
		__resetDefaultTriageServiceForTests();
		__resetDefaultMessageRefStoreForTests();
	});

	it("declares the shared MESSAGE contract and accepts only configured contexts", async () => {
		expect(triageMessagesAction).toMatchObject({
			name: "MESSAGE",
			contexts: ["messaging", "email", "documents"],
			roleGate: { minRole: "ADMIN" },
			similes: ["PRIORITIZE_MESSAGES", "RANK_INBOX", "SCAN_MESSAGES"],
		});
		expect(
			triageMessagesAction.parameters?.map((parameter) => parameter.name),
		).toEqual(["sources", "limit", "sinceMs"]);

		await expect(
			triageMessagesAction.validate?.(
				createFakeRuntime(),
				turn,
				stateFor("documents"),
			),
		).resolves.toBe(true);
		await expect(
			triageMessagesAction.validate?.(
				createFakeRuntime(),
				turn,
				stateFor("contacts"),
			),
		).resolves.toBe(false);
	});

	it("returns the empty-inbox summary when no adapters are registered", async () => {
		const result = await triageMessagesAction.handler(
			createFakeRuntime(),
			turn,
		);

		expect(result).toEqual({
			success: true,
			text: "No new messages across connected platforms.",
			data: { count: 0, messages: [] },
		});
	});

	it("forwards filters and returns messages newest-first with relationship tie-breaking", async () => {
		const gmail = new RecordingListAdapter("gmail", [
			messageRef({
				id: "older-family",
				externalId: "older-family-external",
				from: { identifier: "family@example.com", displayName: "Family" },
				subject: "Older but important",
				receivedAtMs: 1_000,
				isRead: true,
			}),
			messageRef({
				id: "equal-first",
				externalId: "equal-first-external",
				from: { identifier: "first@example.com" },
				receivedAtMs: 2_000,
			}),
			messageRef({
				id: "newest",
				externalId: "newest-external",
				from: { identifier: "newest@example.com" },
				receivedAtMs: 3_000,
			}),
		]);
		const discord = new RecordingListAdapter("discord", [
			messageRef({
				id: "equal-close-friend",
				source: "discord",
				externalId: "equal-close-friend-external",
				from: { identifier: "friend-handle" },
				subject: "Tie broken by relationship",
				receivedAtMs: 2_000,
			}),
			messageRef({
				id: "equal-second",
				source: "discord",
				externalId: "equal-second-external",
				from: { identifier: "second-handle" },
				receivedAtMs: 2_000,
			}),
		]);
		getDefaultTriageService().register(gmail);
		getDefaultTriageService().register(discord);
		const runtime = createFakeRuntime({
			contactsByHandle: new Map([
				[
					"gmail|family@example.com",
					fakeContact("10000000-0000-0000-0000-000000000001" as UUID, [
						"family",
					]),
				],
				[
					"discord|friend-handle",
					fakeContact("10000000-0000-0000-0000-000000000002" as UUID, [
						"close-friend",
					]),
				],
			]),
		});

		const result = await triageMessagesAction.handler(
			runtime,
			turn,
			undefined,
			options({
				sources: ["GMAIL", "discord"],
				limit: "5",
				sinceMs: 500,
			}),
		);

		expect(gmail.seenOptions).toEqual([
			{ sinceMs: 500, limit: 5, worldIds: undefined, channelIds: undefined },
		]);
		expect(discord.seenOptions).toEqual(gmail.seenOptions);
		expect(result.text).toBe(
			"Fetched 5 message(s) across 2 platform(s), newest first.",
		);
		expect(result.data?.count).toBe(5);
		expect(result.data?.messages).toEqual([
			{
				id: "newest",
				source: "gmail",
				from: "newest@example.com",
				subject: null,
				snippet: "Message preview",
				receivedAtMs: 3_000,
				isRead: false,
				contactWeight: 0.5,
				userRepliedInThread: false,
			},
			{
				id: "equal-close-friend",
				source: "discord",
				from: "friend-handle",
				subject: "Tie broken by relationship",
				snippet: "Message preview",
				receivedAtMs: 2_000,
				isRead: false,
				contactWeight: 0.9,
				userRepliedInThread: false,
			},
			{
				id: "equal-first",
				source: "gmail",
				from: "first@example.com",
				subject: null,
				snippet: "Message preview",
				receivedAtMs: 2_000,
				isRead: false,
				contactWeight: 0.5,
				userRepliedInThread: false,
			},
			{
				id: "equal-second",
				source: "discord",
				from: "second-handle",
				subject: null,
				snippet: "Message preview",
				receivedAtMs: 2_000,
				isRead: false,
				contactWeight: 0.5,
				userRepliedInThread: false,
			},
			{
				id: "older-family",
				source: "gmail",
				from: "family@example.com",
				subject: "Older but important",
				snippet: "Message preview",
				receivedAtMs: 1_000,
				isRead: true,
				contactWeight: 1,
				userRepliedInThread: false,
			},
		]);
	});

	it("uses a single requested source and preserves connector failures", async () => {
		const gmail = new RecordingListAdapter("gmail", [
			messageRef({ id: "gmail-only", externalId: "gmail-only-external" }),
		]);
		const discord = new RecordingListAdapter(
			"discord",
			[],
			new Error("discord unavailable"),
		);
		getDefaultTriageService().register(gmail);
		getDefaultTriageService().register(discord);

		const single = await triageMessagesAction.handler(
			createFakeRuntime(),
			turn,
			undefined,
			options({ source: "gmail" }),
		);
		expect(single.data?.count).toBe(1);
		expect(discord.seenOptions).toEqual([]);

		await expect(
			triageMessagesAction.handler(
				createFakeRuntime(),
				turn,
				undefined,
				options({ source: "discord" }),
			),
		).rejects.toThrow("discord unavailable");
	});
});
