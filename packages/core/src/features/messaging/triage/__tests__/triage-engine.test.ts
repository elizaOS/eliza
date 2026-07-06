/**
 * Regression tests for the structural triage engine (#14716): the engine must
 * make no urgency/spam/next-action judgment from message text — those calls
 * belong to the model reading the MESSAGE action output. Deterministic — fake
 * runtime + in-process adapter, no live model, no connector, no DB.
 */

import { beforeEach, describe, expect, it } from "vitest";

import type { IAgentRuntime, UUID } from "../../../../types/index.ts";
import { triageMessagesAction } from "../actions/triageMessages.ts";
import { BaseMessageAdapter } from "../adapters/base.ts";
import { __resetDefaultMessageRefStoreForTests } from "../message-ref-store.ts";
import {
	rankScored,
	resetMissingServiceWarning,
	scoreMessage,
	scoreMessages,
} from "../triage-engine.ts";
import {
	__resetDefaultTriageServiceForTests,
	getDefaultTriageService,
} from "../triage-service.ts";
import type {
	ListOptions,
	MessageAdapterCapabilities,
	MessageRef,
} from "../types.ts";
import { createFakeRuntime, fakeContact } from "./fake-runtime.ts";

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
	constructor(private readonly refs: MessageRef[]) {
		super();
	}
	isAvailable(): boolean {
		return true;
	}
	override capabilities(): MessageAdapterCapabilities {
		return {
			list: true,
			search: false,
			manage: {},
			send: {},
			worlds: "single",
			channels: "none",
		};
	}
	protected override async listMessagesImpl(
		_runtime: IAgentRuntime,
		_opts: ListOptions,
	): Promise<MessageRef[]> {
		return this.refs;
	}
}

describe("triage engine structural scoring (#14716)", () => {
	beforeEach(() => {
		__resetDefaultMessageRefStoreForTests();
		__resetDefaultTriageServiceForTests();
		resetMissingServiceWarning();
	});

	it("does not let urgency keywords outrank recency", async () => {
		const runtime = createFakeRuntime();
		const keywordStuffed = messageRef({
			id: "older-urgent-words",
			externalId: "older",
			subject: "URGENT!! emergency deadline asap",
			snippet:
				"urgent asap emergency deadline today need this now, please help",
			receivedAtMs: 1_000,
		});
		const newerNeutral = messageRef({
			id: "newer-neutral",
			externalId: "newer",
			subject: "Lunch photos",
			snippet: "here are the photos from saturday",
			receivedAtMs: 2_000,
		});

		const ranked = rankScored(
			await scoreMessages(runtime, [keywordStuffed, newerNeutral]),
		);
		expect(ranked.map((m) => m.id)).toEqual([
			"newer-neutral",
			"older-urgent-words",
		]);
	});

	it("attaches no urgency/spam/next-action judgment to any message", async () => {
		const runtime = createFakeRuntime();
		const newsletter = messageRef({
			id: "newsletter",
			from: { identifier: "deals@shop.example" },
			subject: "Weekly newsletter — 50% off sale!",
			snippet:
				"Don't miss this promotion. Click here to unsubscribe from marketing.",
		});

		const score = await scoreMessage(runtime, newsletter);
		expect(score).toEqual({
			contactWeight: 0.5,
			userRepliedInThread: false,
			scoredAt: expect.any(Number),
		});
		// The old engine fabricated these from keyword tables; their absence is
		// the contract — classification happens in the model, not here.
		expect("priority" in score).toBe(false);
		expect("suggestedAction" in score).toBe(false);
		expect("urgencyKeywords" in score).toBe(false);
	});

	it("breaks recency ties by relationship-derived contact weight", async () => {
		const contacts = new Map([
			[
				"gmail|mom@example.com",
				fakeContact("00000000-0000-0000-0000-000000000001" as UUID, ["family"]),
			],
			[
				"gmail|cold-outreach@example.com",
				fakeContact("00000000-0000-0000-0000-000000000002" as UUID, [
					"stranger",
				]),
			],
		]);
		const runtime = createFakeRuntime({ contactsByHandle: contacts });
		const scored = await scoreMessages(runtime, [
			messageRef({
				id: "stranger",
				from: { identifier: "cold-outreach@example.com" },
				receivedAtMs: 5_000,
			}),
			messageRef({
				id: "family",
				from: { identifier: "mom@example.com" },
				receivedAtMs: 5_000,
			}),
		]);

		expect(rankScored(scored).map((m) => m.id)).toEqual(["family", "stranger"]);
		expect(scored.find((m) => m.id === "family")?.triageScore).toMatchObject({
			contactWeight: 1.0,
		});
		// Category weights only ever raise above the default — a categorized
		// stranger floors at DEFAULT_CONTACT_WEIGHT (pre-existing semantics).
		expect(scored.find((m) => m.id === "stranger")?.triageScore).toMatchObject({
			contactWeight: 0.5,
		});
	});

	it("surfaces prior thread engagement as userRepliedInThread", async () => {
		const runtime = createFakeRuntime();
		const score = await scoreMessage(
			runtime,
			messageRef({ id: "threaded", threadId: "thread-1" }),
			{ userRepliedThreadIds: new Set(["thread-1"]) },
		);
		expect(score.userRepliedInThread).toBe(true);
	});

	it("MESSAGE action surfaces raw content + structural signals for the model to judge", async () => {
		const runtime = createFakeRuntime();
		getDefaultTriageService().register(
			new FixedListAdapter([
				messageRef({
					id: "promo",
					from: { identifier: "deals@shop.example" },
					subject: "Flash sale",
					snippet: "Limited offer — unsubscribe anytime",
					receivedAtMs: 9_000,
				}),
			]),
		);

		const result = await triageMessagesAction.handler(
			runtime,
			messageRef({ id: "turn" }) as never,
			undefined,
			{ parameters: {} } as never,
		);

		expect(result.success).toBe(true);
		const messages = result.data?.messages as Array<Record<string, unknown>>;
		expect(messages).toHaveLength(1);
		// The model gets the raw snippet plus typed structural facts — and no
		// pre-baked priority/suggestedAction labels to anchor on.
		expect(messages[0]).toMatchObject({
			id: "promo",
			snippet: "Limited offer — unsubscribe anytime",
			receivedAtMs: 9_000,
			isRead: false,
			contactWeight: 0.5,
			userRepliedInThread: false,
		});
		expect("priority" in messages[0]).toBe(false);
		expect("suggestedAction" in messages[0]).toBe(false);
	});
});
