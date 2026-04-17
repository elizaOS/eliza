import { beforeEach, describe, expect, it } from "vitest";
import type {
	HandlerOptions,
	IAgentRuntime,
	Memory,
	UUID,
} from "../../../../types/index.ts";
import { asUUID } from "../../../../types/index.ts";
import { BaseMessageAdapter } from "../adapters/base.ts";
import { draftFollowupAction } from "../actions/draftFollowup.ts";
import { draftReplyAction } from "../actions/draftReply.ts";
import { listUnifiedInboxAction } from "../actions/listUnifiedInbox.ts";
import { sendDraftAction } from "../actions/sendDraft.ts";
import { triageMessagesAction } from "../actions/triageMessages.ts";
import {
	__resetDefaultTriageServiceForTests,
	getDefaultTriageService,
	TriageService,
} from "../triage-service.ts";
import {
	type DraftRequest,
	type ListOptions,
	type MessageRef,
	type MessageSource,
} from "../types.ts";
import { createFakeRuntime } from "./fake-runtime.ts";

const NOW = 1_700_000_000_000;

class StubAdapter extends BaseMessageAdapter {
	readonly source: MessageSource;
	private messages: MessageRef[];
	private draftCounter = 0;
	sentDraftIds: string[] = [];

	constructor(source: MessageSource, messages: MessageRef[] = []) {
		super();
		this.source = source;
		this.messages = messages;
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

	protected async getMessageImpl(
		_runtime: IAgentRuntime,
		id: string,
	): Promise<MessageRef | null> {
		return this.messages.find((m) => m.id === id) ?? null;
	}

	protected async createDraftImpl(
		_runtime: IAgentRuntime,
		draft: DraftRequest,
	): Promise<{ draftId: string; preview: string }> {
		this.draftCounter++;
		return {
			draftId: `${this.source}-draft-${this.draftCounter}`,
			preview: draft.body.slice(0, 40),
		};
	}

	protected async sendDraftImpl(
		_runtime: IAgentRuntime,
		draftId: string,
	): Promise<{ externalId: string }> {
		this.sentDraftIds.push(draftId);
		return { externalId: `ext-${draftId}` };
	}
}

function makeMemory(): Memory {
	return {
		id: asUUID("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa") as UUID,
		entityId: asUUID("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb") as UUID,
		roomId: asUUID("cccccccc-cccc-cccc-cccc-cccccccccccc") as UUID,
		content: { text: "" },
	} as Memory;
}

function makeMessageRef(partial: Partial<MessageRef> = {}): MessageRef {
	return {
		id: partial.id ?? `ref-${Math.random().toString(36).slice(2)}`,
		source: partial.source ?? "gmail",
		externalId: partial.externalId ?? "ext",
		threadId: partial.threadId,
		from: partial.from ?? { identifier: "alice@example.com" },
		to: partial.to ?? [{ identifier: "me@example.com" }],
		subject: partial.subject ?? "hello",
		snippet: partial.snippet ?? "hi",
		body: partial.body,
		receivedAtMs: partial.receivedAtMs ?? NOW - 30 * 60 * 1000,
		hasAttachments: partial.hasAttachments ?? false,
		isRead: partial.isRead ?? false,
	};
}

/**
 * Actions read the default singleton. We reset it per test and then
 * override the default gmail/telegram adapters with stubs, so the singleton
 * that actions resolve is the same one our tests manipulate.
 */
function registerOntoDefault(): {
	service: TriageService;
	gmail: StubAdapter;
	telegram: StubAdapter;
} {
	__resetDefaultTriageServiceForTests();
	const service = getDefaultTriageService();
	// Clear any previous state
	service.getStore().clear();
	const gmail = new StubAdapter("gmail", [
		makeMessageRef({ id: "g1", source: "gmail" }),
	]);
	const telegram = new StubAdapter("telegram", [
		makeMessageRef({
			id: "t1",
			source: "telegram",
			from: { identifier: "@alice" },
		}),
	]);
	// Overwrite the default Gmail/Telegram adapters with stubs.
	service.register(gmail);
	service.register(telegram);
	return { service, gmail, telegram };
}

describe("triage actions", () => {
	beforeEach(() => {
		__resetDefaultTriageServiceForTests();
	});

	it("TRIAGE_MESSAGES: action metadata matches spec", () => {
		expect(triageMessagesAction.name).toBe("TRIAGE_MESSAGES");
		expect(triageMessagesAction.similes).toEqual(
			expect.arrayContaining([
				"TRIAGE_INBOX",
				"PRIORITIZE_MESSAGES",
				"RANK_INBOX",
				"SCAN_MESSAGES",
			]),
		);
	});

	it("LIST_UNIFIED_INBOX: action metadata matches spec", () => {
		expect(listUnifiedInboxAction.name).toBe("LIST_UNIFIED_INBOX");
		expect(listUnifiedInboxAction.similes).toEqual(
			expect.arrayContaining([
				"UNIFIED_INBOX",
				"LIST_MESSAGES",
				"SHOW_UNREAD_ACROSS",
			]),
		);
	});

	it("DRAFT_REPLY: action metadata matches spec", () => {
		expect(draftReplyAction.name).toBe("DRAFT_REPLY");
		expect(draftReplyAction.similes).toEqual(
			expect.arrayContaining(["COMPOSE_REPLY", "DRAFT_MESSAGE_REPLY"]),
		);
	});

	it("DRAFT_FOLLOWUP: action metadata matches spec", () => {
		expect(draftFollowupAction.name).toBe("DRAFT_FOLLOWUP");
		expect(draftFollowupAction.similes).toEqual(
			expect.arrayContaining([
				"COMPOSE_FOLLOWUP",
				"FOLLOWUP_DRAFT",
				"CHECK_IN_DRAFT",
			]),
		);
	});

	it("SEND_DRAFT: action metadata matches spec", () => {
		expect(sendDraftAction.name).toBe("SEND_DRAFT");
		expect(sendDraftAction.similes).toEqual(
			expect.arrayContaining([
				"SEND_MESSAGE",
				"DISPATCH_DRAFT",
				"CONFIRM_AND_SEND",
			]),
		);
	});

	it("TRIAGE_MESSAGES: success path produces ranked results", async () => {
		registerOntoDefault();
		const runtime = createFakeRuntime();
		const result = await triageMessagesAction.handler(
			runtime,
			makeMemory(),
			undefined,
			{ parameters: { sources: ["gmail", "telegram"] } } as HandlerOptions,
		);
		expect(result.success).toBe(true);
		const data = result.data as { count: number } | undefined;
		expect(data?.count).toBeGreaterThanOrEqual(2);
	});

	it("LIST_UNIFIED_INBOX: returns unread across sources", async () => {
		registerOntoDefault();
		const runtime = createFakeRuntime();
		const result = await listUnifiedInboxAction.handler(
			runtime,
			makeMemory(),
			undefined,
			{ parameters: {} } as HandlerOptions,
		);
		expect(result.success).toBe(true);
		const data = result.data as { total: number } | undefined;
		expect(data?.total).toBeGreaterThanOrEqual(2);
	});

	it("DRAFT_REPLY: produces a draft preview against a stored message", async () => {
		const { gmail } = registerOntoDefault();
		const runtime = createFakeRuntime();
		// Seed: triage first so the message is in the store.
		await triageMessagesAction.handler(runtime, makeMemory(), undefined, {
			parameters: { sources: ["gmail"] },
		} as HandlerOptions);
		const result = await draftReplyAction.handler(
			runtime,
			makeMemory(),
			undefined,
			{
				parameters: { messageId: "g1", body: "Thanks, will do." },
			} as HandlerOptions,
		);
		expect(result.success).toBe(true);
		const data = result.data as { draftId: string; source: string };
		expect(data.source).toBe("gmail");
		expect(data.draftId).toMatch(/^gmail-draft-/);
		expect(gmail.sentDraftIds).toEqual([]);
	});

	it("DRAFT_REPLY: missing messageId returns error without sending", async () => {
		registerOntoDefault();
		const runtime = createFakeRuntime();
		const result = await draftReplyAction.handler(
			runtime,
			makeMemory(),
			undefined,
			{ parameters: { body: "hi" } } as HandlerOptions,
		);
		expect(result.success).toBe(false);
	});

	it("DRAFT_FOLLOWUP: produces a draft for explicit recipient on a platform", async () => {
		registerOntoDefault();
		const runtime = createFakeRuntime();
		const result = await draftFollowupAction.handler(
			runtime,
			makeMemory(),
			undefined,
			{
				parameters: {
					source: "telegram",
					to: ["@alice"],
					body: "Hey — checking in!",
				},
			} as HandlerOptions,
		);
		expect(result.success).toBe(true);
		const data = result.data as { draftId: string; source: string };
		expect(data.source).toBe("telegram");
	});

	it("SEND_DRAFT: SAFETY — without confirmed=true, does NOT send and returns preview", async () => {
		const { telegram } = registerOntoDefault();
		const runtime = createFakeRuntime();
		const draft = await draftFollowupAction.handler(
			runtime,
			makeMemory(),
			undefined,
			{
				parameters: {
					source: "telegram",
					to: ["@alice"],
					body: "Hey — checking in!",
				},
			} as HandlerOptions,
		);
		const draftId = (draft.data as { draftId: string }).draftId;

		const result = await sendDraftAction.handler(
			runtime,
			makeMemory(),
			undefined,
			{ parameters: { draftId } } as HandlerOptions,
		);
		expect(result.success).toBe(false);
		const data = result.data as {
			requiresConfirmation: boolean;
			preview: string;
		};
		expect(data.requiresConfirmation).toBe(true);
		expect(typeof data.preview).toBe("string");
		expect(telegram.sentDraftIds).toEqual([]);
	});

	it("SEND_DRAFT: with confirmed=true, actually dispatches via adapter", async () => {
		const { telegram } = registerOntoDefault();
		const runtime = createFakeRuntime();
		const draft = await draftFollowupAction.handler(
			runtime,
			makeMemory(),
			undefined,
			{
				parameters: {
					source: "telegram",
					to: ["@alice"],
					body: "Hey — checking in!",
				},
			} as HandlerOptions,
		);
		const draftId = (draft.data as { draftId: string }).draftId;

		const result = await sendDraftAction.handler(
			runtime,
			makeMemory(),
			undefined,
			{ parameters: { draftId, confirmed: true } } as HandlerOptions,
		);
		expect(result.success).toBe(true);
		expect(telegram.sentDraftIds).toContain(draftId);
	});

	it("SEND_DRAFT: unknown draftId fails cleanly without sending", async () => {
		registerOntoDefault();
		const runtime = createFakeRuntime();
		const result = await sendDraftAction.handler(
			runtime,
			makeMemory(),
			undefined,
			{
				parameters: { draftId: "nonexistent", confirmed: true },
			} as HandlerOptions,
		);
		expect(result.success).toBe(false);
	});
});
