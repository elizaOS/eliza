/**
 * Exercises the one-shot reply action through the real in-memory triage service
 * and a recording connector adapter. The suite covers target lookup, fallback
 * reply generation, direct delivery, and approval-gated delivery without a
 * live connector, database, or model.
 */

import { beforeEach, describe, expect, it } from "vitest";
import type {
	HandlerCallback,
	IAgentRuntime,
	Memory,
} from "../../../../types/index.ts";
import { BaseMessageAdapter } from "../adapters/base.ts";
import {
	__resetDefaultMessageRefStoreForTests,
	getDefaultMessageRefStore,
} from "../message-ref-store.ts";
import { registerSendPolicy, type SendPolicy } from "../send-policy.ts";
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
import { respondToMessageAction } from "./respondToMessage.ts";

const turn = { content: { text: "Reply to the message" } } as Memory;

function messageRef(overrides: Partial<MessageRef> = {}): MessageRef {
	return {
		id: "message-1",
		source: "gmail",
		externalId: "external-1",
		threadId: "thread-1",
		from: { identifier: "alice@example.com", displayName: "Alice" },
		to: [{ identifier: "owner@example.com" }],
		subject: "Status update",
		snippet: "Here is the latest update.",
		receivedAtMs: 1_000,
		hasAttachments: false,
		isRead: false,
		worldId: "owner@example.com",
		channelId: "inbox",
		...overrides,
	};
}

class RecordingAdapter extends BaseMessageAdapter {
	readonly source: MessageSource = "gmail";
	readonly created: DraftRequest[] = [];
	readonly sent: string[] = [];

	constructor(private readonly messages: MessageRef[] = []) {
		super();
	}

	isAvailable(): boolean {
		return true;
	}

	protected async listMessagesImpl(
		_runtime: IAgentRuntime,
		_opts: ListOptions,
	): Promise<MessageRef[]> {
		return this.messages;
	}

	protected async createDraftImpl(
		_runtime: IAgentRuntime,
		draft: DraftRequest,
	): Promise<{ draftId: string; preview: string }> {
		this.created.push(draft);
		return {
			draftId: `draft-${this.created.length}`,
			preview: draft.body,
		};
	}

	protected async sendDraftImpl(
		_runtime: IAgentRuntime,
		draftId: string,
	): Promise<{ externalId: string }> {
		this.sent.push(draftId);
		return { externalId: `sent-${draftId}` };
	}
}

function runtime(): IAgentRuntime {
	return { agentId: "00000000-0000-0000-0000-000000000001" } as IAgentRuntime;
}

function register(adapter: RecordingAdapter): void {
	getDefaultTriageService().register(adapter);
}

describe("respondToMessageAction", () => {
	beforeEach(() => {
		__resetDefaultMessageRefStoreForTests();
		__resetDefaultTriageServiceForTests();
	});

	it("surfaces only for an active messaging context", async () => {
		const active = {
			values: {
				__contextRouting: { primaryContext: "email" },
			},
		} as never;
		const unrelated = {
			values: {
				__contextRouting: { primaryContext: "payments" },
			},
		} as never;

		await expect(
			respondToMessageAction.validate(runtime(), turn, active),
		).resolves.toBe(true);
		await expect(
			respondToMessageAction.validate(runtime(), turn, unrelated),
		).resolves.toBe(false);
	});

	it("returns a failure when lookup finds no matching message", async () => {
		const adapter = new RecordingAdapter();
		register(adapter);

		const result = await respondToMessageAction.handler(
			runtime(),
			turn,
			undefined,
			{ parameters: { sender: "Nobody", body: "Hello" } } as never,
		);

		expect(result).toEqual({
			success: false,
			text: "No matching message found to reply to.",
			error: "No matching message found to reply to.",
		});
		expect(adapter.created).toEqual([]);
		expect(adapter.sent).toEqual([]);
	});

	it("uses an explicit message id and sends the supplied body", async () => {
		const adapter = new RecordingAdapter();
		register(adapter);
		getDefaultMessageRefStore().saveMessage(messageRef());
		const callbackMessages: Array<{ text?: string; action?: string }> = [];
		const callback: HandlerCallback = async (content) => {
			callbackMessages.push(content);
		};

		const result = await respondToMessageAction.handler(
			runtime(),
			turn,
			undefined,
			{
				parameters: { messageId: "message-1", body: "Tomorrow works." },
			} as never,
			callback,
		);

		expect(adapter.created).toEqual([
			expect.objectContaining({
				inReplyToId: "message-1",
				threadId: "thread-1",
				to: [{ identifier: "alice@example.com", displayName: "Alice" }],
				subject: "Re: Status update",
				body: "Tomorrow works.",
				worldId: "owner@example.com",
				channelId: "inbox",
			}),
		]);
		expect(adapter.sent).toEqual(["draft-1"]);
		expect(callbackMessages).toEqual([
			{ text: "Replied on gmail.", action: "MESSAGE" },
		]);
		expect(result).toMatchObject({
			success: true,
			text: "Replied on gmail.",
			userFacingText: "Replied on gmail.",
			verifiedUserFacing: true,
			turnComplete: true,
			data: {
				draftId: "draft-1",
				source: "gmail",
				externalId: "sent-draft-1",
				inReplyToId: "message-1",
			},
		});
	});

	it("searches by sender and content and replies to the newest match", async () => {
		const adapter = new RecordingAdapter([
			messageRef({
				id: "older",
				externalId: "older-external",
				subject: "Product brief",
				snippet: "Please review the product brief.",
				receivedAtMs: 1_000,
			}),
			messageRef({
				id: "newer",
				externalId: "newer-external",
				subject: "Product brief update",
				snippet: "The product brief has updated figures.",
				receivedAtMs: 2_000,
			}),
			messageRef({
				id: "other-sender",
				externalId: "other-external",
				from: { identifier: "bob@example.com", displayName: "Bob" },
				subject: "Product brief update",
				snippet: "The product brief has updated figures.",
				receivedAtMs: 3_000,
			}),
		]);
		register(adapter);

		await respondToMessageAction.handler(runtime(), turn, undefined, {
			parameters: { sender: "Alice", content: "updated figures" },
		} as never);

		expect(adapter.created).toHaveLength(1);
		expect(adapter.created[0]).toMatchObject({
			inReplyToId: "newer",
			body: "Thanks, I will review the product brief and send over any notes.",
		});
	});

	it.each([
		[
			"invoice reference",
			{ subject: "Invoice INV-42", snippet: "Attached." },
			"Confirmed, thank you. I received invoice inv-42.",
		],
		[
			"signed vendor packet",
			{ subject: undefined, snippet: "The signed vendor packet is attached." },
			"Thanks for sending the signed vendor packet. I will review it and follow up if anything else is needed.",
		],
		[
			"product brief",
			{ subject: undefined, snippet: "Sharing the product brief." },
			"Thanks, I will review the product brief and send over any notes.",
		],
		[
			"looking-forward note",
			{ subject: undefined, snippet: "Looking forward to tomorrow." },
			"Likewise, looking forward to it.",
		],
		[
			"generic message",
			{ subject: undefined, snippet: "An ordinary update." },
			"Thanks for sending this. I will review it and get back to you shortly.",
		],
	])(
		"synthesizes the conservative %s fallback",
		async (_name, fields, expected) => {
			const adapter = new RecordingAdapter();
			register(adapter);
			getDefaultMessageRefStore().saveMessage(messageRef(fields));

			await respondToMessageAction.handler(runtime(), turn, undefined, {
				parameters: { messageId: "message-1" },
			} as never);

			expect(adapter.created[0]?.body).toBe(expected);
		},
	);

	it("queues an approval-gated reply and sends only when its executor runs", async () => {
		const adapter = new RecordingAdapter();
		register(adapter);
		getDefaultMessageRefStore().saveMessage(messageRef());
		const currentRuntime = runtime();
		let pendingDraft: DraftRequest | undefined;
		let executor: (() => Promise<{ externalId: string }>) | undefined;
		const policy: SendPolicy = {
			async shouldRequireApproval(_runtime, draft) {
				pendingDraft = draft;
				return true;
			},
			async enqueueApproval(_runtime, draft, send) {
				pendingDraft = draft;
				executor = send;
				return { requestId: "approval-1", preview: draft.body };
			},
		};
		registerSendPolicy(currentRuntime, policy);
		const callbackMessages: Array<{ text?: string; action?: string }> = [];

		const result = await respondToMessageAction.handler(
			currentRuntime,
			turn,
			undefined,
			{
				parameters: { messageId: "message-1", body: "Approved text" },
			} as never,
			async (content) => {
				callbackMessages.push(content);
			},
		);

		expect(pendingDraft).toMatchObject({
			inReplyToId: "message-1",
			body: "Approved text",
		});
		expect(adapter.sent).toEqual([]);
		expect(callbackMessages).toEqual([
			{
				text: "I've drafted the reply on gmail — it's waiting for approval before it goes out.",
				action: "MESSAGE",
			},
		]);
		expect(result).toMatchObject({
			success: true,
			text: "Reply drafted on gmail and pending approval (request approval-1).",
			verifiedUserFacing: true,
			turnComplete: true,
			continueChain: false,
			data: {
				requiresConfirmation: true,
				pending: true,
				requestId: "approval-1",
				preview: "Approved text",
				draftId: "draft-1",
				source: "gmail",
				inReplyToId: "message-1",
			},
		});
		if (!executor) throw new Error("Expected an approval executor");
		await expect(executor()).resolves.toEqual({ externalId: "sent-draft-1" });
		expect(adapter.sent).toEqual(["draft-1"]);
	});

	it("sends immediately when the registered policy does not require approval", async () => {
		const adapter = new RecordingAdapter();
		register(adapter);
		getDefaultMessageRefStore().saveMessage(messageRef());
		const currentRuntime = runtime();
		const policy: SendPolicy = {
			async shouldRequireApproval() {
				return false;
			},
			async enqueueApproval() {
				throw new Error("enqueueApproval must not be called");
			},
		};
		registerSendPolicy(currentRuntime, policy);

		const result = await respondToMessageAction.handler(
			currentRuntime,
			turn,
			undefined,
			{ parameters: { messageId: "message-1", body: "Send now" } } as never,
		);

		expect(adapter.sent).toEqual(["draft-1"]);
		expect(result.text).toBe("Replied on gmail.");
	});
});
