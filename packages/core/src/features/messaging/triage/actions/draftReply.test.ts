/**
 * Exercises the MESSAGE reply-drafting action through the real default
 * TriageService and an in-process recording adapter. The suite covers context
 * eligibility, invalid input, explicit and searched targets, empty searches,
 * callback delivery, draft persistence, and service failures.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type {
	Content,
	HandlerCallback,
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
import type {
	DraftRequest,
	ListOptions,
	MessageRef,
	MessageSource,
} from "../types.ts";
import { draftReplyAction } from "./draftReply.ts";

class RecordingReplyAdapter extends BaseMessageAdapter {
	readonly source: MessageSource = "gmail";
	lastDraft: DraftRequest | undefined;
	createCount = 0;

	constructor(private readonly messages: MessageRef[] = []) {
		super();
	}

	isAvailable(): boolean {
		return true;
	}

	protected listMessagesImpl(
		_runtime: IAgentRuntime,
		_opts: ListOptions,
	): Promise<MessageRef[]> {
		return Promise.resolve(this.messages);
	}

	protected createDraftImpl(
		_runtime: IAgentRuntime,
		draft: DraftRequest,
	): Promise<{ draftId: string; preview: string }> {
		this.createCount += 1;
		this.lastDraft = draft;
		return Promise.resolve({
			draftId: "gmail-draft-1",
			preview: `Gmail preview: ${draft.body}`,
		});
	}
}

const turn = { content: { text: "Draft a reply" } } as Memory;

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

function messageRef(overrides: Partial<MessageRef> = {}): MessageRef {
	return {
		id: "gmail-message-1",
		source: "gmail",
		externalId: "external-1",
		threadId: "thread-1",
		from: { identifier: "alice@example.com", displayName: "Alice" },
		to: [{ identifier: "owner@example.com" }],
		subject: "Project update",
		snippet: "The launch plan is ready",
		receivedAtMs: 1_000,
		hasAttachments: false,
		isRead: false,
		...overrides,
	};
}

describe("draftReplyAction", () => {
	beforeEach(() => {
		__resetDefaultMessageRefStoreForTests();
		__resetDefaultTriageServiceForTests();
	});

	afterEach(() => {
		__resetDefaultTriageServiceForTests();
		__resetDefaultMessageRefStoreForTests();
	});

	it("is eligible only when the turn has a supported messaging context", async () => {
		await expect(
			draftReplyAction.validate?.(
				createFakeRuntime(),
				turn,
				stateFor("messaging"),
			),
		).resolves.toBe(true);
		await expect(
			draftReplyAction.validate?.(
				createFakeRuntime(),
				turn,
				stateFor("payments"),
			),
		).resolves.toBe(false);
	});

	it("rejects a missing body before searching or creating a draft", async () => {
		const adapter = new RecordingReplyAdapter([messageRef()]);
		getDefaultTriageService().register(adapter);

		const result = await draftReplyAction.handler(
			createFakeRuntime(),
			turn,
			undefined,
			options({ messageId: "gmail-message-1" }),
		);

		expect(result).toEqual({
			success: false,
			text: "body is required",
			error: "body is required",
		});
		expect(adapter.createCount).toBe(0);
	});

	it("drafts against an explicit message ID and delivers the persisted preview", async () => {
		const original = messageRef();
		const adapter = new RecordingReplyAdapter();
		const service = getDefaultTriageService();
		service.register(adapter);
		service.getStore().saveMessage(original);
		const delivered: Content[] = [];
		const callback: HandlerCallback = async (content) => {
			delivered.push(content);
			return [];
		};

		const result = await draftReplyAction.handler(
			createFakeRuntime(),
			turn,
			undefined,
			options({ messageId: original.id, body: " Thanks, Alice. " }),
			callback,
		);

		expect(adapter.lastDraft).toEqual({
			source: "gmail",
			inReplyToId: original.id,
			threadId: "thread-1",
			to: [{ identifier: "alice@example.com", displayName: "Alice" }],
			subject: "Re: Project update",
			body: "Thanks, Alice.",
			worldId: undefined,
			channelId: undefined,
		});
		expect(result).toEqual({
			success: true,
			text: "Drafted reply on gmail. Preview: Gmail preview: Thanks, Alice.",
			data: {
				draftId: "gmail-draft-1",
				source: "gmail",
				preview: "Gmail preview: Thanks, Alice.",
				inReplyToId: original.id,
			},
		});
		expect(delivered).toEqual([
			{
				text: "Drafted reply on gmail. Preview: Gmail preview: Thanks, Alice.",
				action: "MESSAGE",
			},
		]);
		expect(service.getStore().getDraft("gmail-draft-1")).toMatchObject({
			draftId: "gmail-draft-1",
			inReplyToId: original.id,
			body: "Thanks, Alice.",
			preview: "Gmail preview: Thanks, Alice.",
			sent: false,
		});
	});

	it("searches lookup hints and drafts against the newest matching message", async () => {
		const older = messageRef({
			id: "older-match",
			externalId: "external-older",
			receivedAtMs: 2_000,
		});
		const newer = messageRef({
			id: "newer-match",
			externalId: "external-newer",
			threadId: "thread-newer",
			receivedAtMs: 3_000,
		});
		const wrongSender = messageRef({
			id: "wrong-sender",
			externalId: "external-wrong",
			from: { identifier: "bob@example.com", displayName: "Bob" },
			receivedAtMs: 4_000,
		});
		const adapter = new RecordingReplyAdapter([older, newer, wrongSender]);
		getDefaultTriageService().register(adapter);

		const result = await draftReplyAction.handler(
			createFakeRuntime(),
			turn,
			undefined,
			options({
				sender: "Alice",
				content: "launch plan",
				body: "Looks good to me.",
			}),
		);

		expect(result.success).toBe(true);
		expect(result.data?.inReplyToId).toBe("newer-match");
		expect(adapter.lastDraft?.inReplyToId).toBe("newer-match");
	});

	it("returns a distinct failure when lookup finds no matching message", async () => {
		const adapter = new RecordingReplyAdapter([messageRef()]);
		getDefaultTriageService().register(adapter);

		const result = await draftReplyAction.handler(
			createFakeRuntime(),
			turn,
			undefined,
			options({ sender: "Nobody", body: "Hello" }),
		);

		expect(result).toEqual({
			success: false,
			text: "No matching message found to draft a reply to.",
			error: "No matching message found to draft a reply to.",
		});
		expect(adapter.createCount).toBe(0);
	});

	it("propagates the service error for an explicit missing message", async () => {
		getDefaultTriageService().register(new RecordingReplyAdapter());

		await expect(
			draftReplyAction.handler(
				createFakeRuntime(),
				turn,
				undefined,
				options({ messageId: "missing", body: "Hello" }),
			),
		).rejects.toThrow("No message found for id missing");
	});
});
