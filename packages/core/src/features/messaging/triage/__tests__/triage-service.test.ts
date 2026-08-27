/**
 * Runtime unit coverage for TriageService registry, routing, message reads,
 * management, drafting, and immediate delivery using real in-memory state.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import type { IAgentRuntime } from "../../../../types/index.ts";
import { MessageRefStore } from "../message-ref-store.ts";
import {
	__resetDefaultTriageServiceForTests,
	getDefaultTriageService,
	TriageService,
} from "../triage-service.ts";
import type {
	DraftRecord,
	MessageAdapter,
	MessageAdapterCapabilities,
	MessageRef,
	MessageSource,
} from "../types.ts";

function runtime(agentId = "agent-triage-service"): IAgentRuntime {
	return {
		agentId,
		getService: () => null,
	} as unknown as IAgentRuntime;
}

function capabilities(): MessageAdapterCapabilities {
	return {
		list: true,
		search: false,
		manage: {},
		send: { reply: true, new: true },
		worlds: "single",
		channels: "none",
	};
}

function message(
	id: string,
	source: MessageSource = "gmail",
	overrides: Partial<MessageRef> = {},
): MessageRef {
	return {
		id,
		source,
		externalId: `external-${id}`,
		from: { identifier: "sender@example.com", displayName: "Sender" },
		to: [],
		subject: "Quarterly update",
		snippet: `message ${id}`,
		receivedAtMs: 1_000,
		hasAttachments: false,
		isRead: false,
		...overrides,
	};
}

function draft(
	draftId = "draft-1",
	overrides: Partial<DraftRecord> = {},
): DraftRecord {
	return {
		draftId,
		source: "gmail",
		to: [{ identifier: "recipient@example.com" }],
		body: "Draft body",
		preview: "Draft preview",
		createdAtMs: 1_000,
		sent: false,
		...overrides,
	};
}

function adapter(
	source: MessageSource = "gmail",
	overrides: Partial<MessageAdapter> = {},
): MessageAdapter {
	return {
		source,
		isAvailable: () => true,
		capabilities,
		listMessages: async () => [],
		getMessage: async () => null,
		createDraft: async (_runtime, request) => ({
			draftId: "provider-draft-1",
			preview: request.body,
		}),
		sendDraft: async () => ({ externalId: "provider-message-1" }),
		...overrides,
	};
}

afterEach(() => {
	__resetDefaultTriageServiceForTests();
});

describe("TriageService registry and routing", () => {
	it("registers adapters in insertion order and replaces duplicate sources", () => {
		const store = new MessageRefStore();
		const service = new TriageService(store);
		const firstGmail = adapter("gmail");
		const discord = adapter("discord");
		const replacementGmail = adapter("gmail");

		service.register(firstGmail);
		service.register(discord);
		service.register(replacementGmail);

		expect(service.getAdapter("gmail")).toBe(replacementGmail);
		expect(service.listRegisteredSources()).toEqual(["gmail", "discord"]);
		expect(service.listAdapters()).toEqual([replacementGmail, discord]);
		expect(service.getStore()).toBe(store);
	});

	it("resolves routed messages, falls back to the store, and returns undefined for misses", async () => {
		const store = new MessageRefStore();
		const service = new TriageService(store);
		const gmail = adapter("gmail", {
			listMessages: async () => [message("routed")],
		});
		const discord = adapter("discord");
		service.register(gmail);
		service.register(discord);

		await service.triage(runtime(), { sources: ["gmail"] });
		store.saveMessage(message("stored", "discord"));

		expect(service.getAdapterForMessage("routed")).toBe(gmail);
		expect(service.getAdapterForMessage("stored")).toBe(discord);
		expect(service.getAdapterForMessage("missing")).toBeUndefined();
	});

	it("bounds the message-to-adapter route cache at production capacity", async () => {
		const store = new MessageRefStore();
		const service = new TriageService(store);
		const gmail = adapter("gmail", {
			listMessages: async () =>
				Array.from({ length: 5_001 }, (_, index) =>
					message(`route-${index}`, "gmail", { receivedAtMs: index }),
				),
		});
		service.register(gmail);

		await service.triage(runtime(), { sources: ["gmail"], nowMs: 10_000 });

		// Cache is a 5000-entry FIFO. Store retains every triaged ref (#28112).
		expect(service.__adapterRouteCacheSizeForTests()).toBe(5_000);
		expect(service.__hasAdapterRouteCacheEntryForTests("route-0")).toBe(false);
		expect(service.__hasAdapterRouteCacheEntryForTests("route-5000")).toBe(
			true,
		);
		expect(store.listMessages()).toHaveLength(5_001);
		// Evicted cache entries still route through the authoritative store.
		expect(service.getAdapterForMessage("route-0")).toBe(gmail);
		expect(service.getAdapterForMessage("route-5000")).toBe(gmail);
	});

	it("keeps one lazy singleton until it is explicitly reset", () => {
		const first = getDefaultTriageService();
		first.register(adapter("gmail"));

		expect(getDefaultTriageService()).toBe(first);
		__resetDefaultTriageServiceForTests();
		expect(getDefaultTriageService()).not.toBe(first);
		expect(getDefaultTriageService().listRegisteredSources()).toEqual([]);
	});
});

describe("TriageService message reads and search ordering", () => {
	it("rejects missing, unavailable, unsupported, and mismatched read adapters", async () => {
		const service = new TriageService(new MessageRefStore());
		await expect(
			service.readMessage(runtime(), "gmail", { messageId: "missing" }),
		).rejects.toMatchObject({ code: "MESSAGE_READ_ADAPTER_NOT_FOUND" });

		service.register(adapter("gmail", { isAvailable: () => false }));
		await expect(
			service.readMessage(runtime(), "gmail", { messageId: "missing" }),
		).rejects.toMatchObject({ code: "MESSAGE_READ_ADAPTER_UNAVAILABLE" });

		service.register(adapter("gmail"));
		await expect(
			service.readMessage(runtime(), "gmail", { messageId: "missing" }),
		).rejects.toMatchObject({ code: "MESSAGE_READ_NOT_SUPPORTED" });

		service.getStore().saveMessage(message("discord-message", "discord"));
		service.register(
			adapter("gmail", {
				readMessage: async () => ({ text: "body", readView: {} as never }),
			}),
		);
		await expect(
			service.readMessage(runtime(), "gmail", {
				messageId: "discord-message",
			}),
		).rejects.toMatchObject({ code: "MESSAGE_READ_SOURCE_MISMATCH" });
	});

	it("fills a missing read world from stored metadata without overriding an explicit world", async () => {
		const readMessage = vi.fn(async () => ({
			text: "body",
			readView: {} as never,
		}));
		const service = new TriageService(new MessageRefStore());
		service.register(adapter("gmail", { readMessage }));
		service
			.getStore()
			.saveMessage(message("stored", "gmail", { worldId: "stored-world" }));

		await service.readMessage(runtime(), "gmail", { messageId: "stored" });
		await service.readMessage(runtime(), "gmail", {
			messageId: "stored",
			worldId: "explicit-world",
		});

		expect(readMessage.mock.calls[0]?.[1]).toMatchObject({
			messageId: "stored",
			worldId: "stored-world",
		});
		expect(readMessage.mock.calls[1]?.[1]).toMatchObject({
			worldId: "explicit-world",
		});
	});

	it("sorts searches newest-first with deterministic ids breaking ties", async () => {
		const service = new TriageService(new MessageRefStore());
		service.register(
			adapter("gmail", {
				searchMessages: async () => [
					message("old", "gmail", { receivedAtMs: 1 }),
					message("tie-b", "gmail", { receivedAtMs: 3 }),
					message("tie-a", "gmail", { receivedAtMs: 3 }),
				],
			}),
		);

		const result = await service.searchWithReceipt(runtime(), {
			content: "message",
			limit: 2.9,
		});

		expect(result.refs.map(({ id }) => id)).toEqual(["tie-a", "tie-b"]);
		expect(result.receipt).toMatchObject({
			requested: ["gmail"],
			succeeded: ["gmail"],
			limit: 2,
			hasMore: true,
		});
	});

	it("orders non-finite timestamps as epoch values without corrupting peers", async () => {
		const service = new TriageService(new MessageRefStore());
		service.register(
			adapter("gmail", {
				searchMessages: async () => [
					message("nan", "gmail", { receivedAtMs: Number.NaN }),
					message("newest", "gmail", { receivedAtMs: 5 }),
					message("infinity", "gmail", {
						receivedAtMs: Number.POSITIVE_INFINITY,
					}),
					message("older", "gmail", { receivedAtMs: 1 }),
				],
			}),
		);

		const refs = await service.search(runtime(), { content: "message" });

		expect(refs.map(({ id }) => id)).toEqual([
			"newest",
			"older",
			"infinity",
			"nan",
		]);
	});

	it.each([undefined, 0, -1, Number.NaN])(
		"treats %s as no measurable search cap",
		async (limit) => {
			const service = new TriageService(new MessageRefStore());
			service.register(
				adapter("gmail", {
					searchMessages: async () => [message("one")],
				}),
			);

			const result = await service.searchWithReceipt(runtime(), {
				content: "message",
				limit,
			});

			expect(result.receipt.limit).toBeNull();
			expect(result.receipt.hasMore).toBeNull();
		},
	);

	it("reports unavailable and unregistered sources without calling them", async () => {
		const listMessages = vi.fn(async () => [message("unreachable")]);
		const service = new TriageService(new MessageRefStore());
		service.register(
			adapter("gmail", { isAvailable: () => false, listMessages }),
		);

		const result = await service.searchWithReceipt(runtime(), {
			sources: ["gmail", "discord"],
		});

		expect(result.refs).toEqual([]);
		expect(result.receipt).toMatchObject({
			succeeded: [],
			unavailable: ["gmail"],
			unregistered: ["discord"],
			failed: [],
		});
		expect(listMessages).not.toHaveBeenCalled();
	});
});

describe("TriageService management and drafts", () => {
	it("returns explicit failures for unresolved messages and missing local tag targets", async () => {
		const service = new TriageService(new MessageRefStore());

		await expect(
			service.manage(runtime(), "missing", { kind: "archive" }),
		).resolves.toEqual({
			ok: false,
			reason: "no adapter resolved for message missing",
		});

		service.register(adapter("gmail"));
		await expect(
			service.manage(
				runtime(),
				"missing",
				{ kind: "tag_add", tag: "urgent" },
				{ source: "gmail" },
			),
		).resolves.toEqual({
			ok: false,
			reason: "message missing not in store",
		});
	});

	it("applies local tag mutations even when removal targets a missing tag", async () => {
		const service = new TriageService(new MessageRefStore());
		service.register(adapter("gmail"));
		service.getStore().saveMessage(message("managed"));

		await expect(
			service.manage(
				runtime(),
				"managed",
				{ kind: "tag_add", tag: "urgent" },
				{ source: "gmail" },
			),
		).resolves.toEqual({ ok: true });
		await expect(
			service.manage(
				runtime(),
				"managed",
				{ kind: "tag_remove", tag: "absent" },
				{ source: "gmail" },
			),
		).resolves.toEqual({ ok: true });
		expect(service.getStore().getMessage("managed")?.tags).toEqual(["urgent"]);
	});

	it("rejects unsupported remote operations and delegates supported ones", async () => {
		const service = new TriageService(new MessageRefStore());
		service.register(adapter("gmail"));
		await expect(
			service.manage(
				runtime(),
				"managed",
				{ kind: "archive" },
				{ source: "gmail" },
			),
		).resolves.toEqual({
			ok: false,
			reason: "gmail adapter does not implement manageMessage",
		});

		const manageMessage = vi.fn(async () => ({ ok: true }));
		service.register(adapter("gmail", { manageMessage }));
		await expect(
			service.manage(
				runtime(),
				"managed",
				{ kind: "mark_read", read: true },
				{ source: "gmail" },
			),
		).resolves.toEqual({ ok: true });
		expect(manageMessage).toHaveBeenCalledWith(expect.anything(), "managed", {
			kind: "mark_read",
			read: true,
		});
	});

	it("builds reply drafts with observed subject and routing metadata", async () => {
		const createDraft = vi.fn(async (_runtime, request) => ({
			draftId: `draft-${request.inReplyToId}`,
			preview: request.body,
		}));
		const service = new TriageService(new MessageRefStore());
		service.register(adapter("gmail", { createDraft }));
		service.getStore().saveMessages([
			message("plain", "gmail", {
				threadId: "thread-1",
				worldId: "world-1",
				channelId: "channel-1",
			}),
			message("reply", "gmail", { subject: "RE: Existing" }),
			message("no-subject", "gmail", { subject: undefined }),
		]);

		const plain = await service.draftReply(runtime(), "plain", "Answer");
		const reply = await service.draftReply(runtime(), "reply", "Answer");
		const noSubject = await service.draftReply(
			runtime(),
			"no-subject",
			"Answer",
		);

		expect(plain).toMatchObject({
			draftId: "draft-plain",
			inReplyToId: "plain",
			threadId: "thread-1",
			subject: "Re: Quarterly update",
			worldId: "world-1",
			channelId: "channel-1",
			sent: false,
		});
		expect(reply.subject).toBe("RE: Existing");
		expect(noSubject.subject).toBeUndefined();
		expect(service.getStore().getDraft("draft-plain")).toEqual(plain);
	});

	it("rejects reply drafts without a stored message or registered adapter", async () => {
		const service = new TriageService(new MessageRefStore());
		await expect(
			service.draftReply(runtime(), "missing", "Answer"),
		).rejects.toThrow("No message found for id missing");

		service.getStore().saveMessage(message("known"));
		await expect(
			service.draftReply(runtime(), "known", "Answer"),
		).rejects.toThrow('No adapter registered for source "gmail"');
	});

	it("creates and stores new follow-up drafts and rejects unknown sources", async () => {
		const createDraft = vi.fn(async (_runtime, request) => ({
			draftId: "followup-1",
			preview: request.body,
		}));
		const service = new TriageService(new MessageRefStore());
		service.register(adapter("gmail", { createDraft }));
		const params = {
			source: "gmail" as const,
			to: [{ identifier: "recipient@example.com" }],
			subject: "Hello",
			body: "Following up",
			threadId: "thread-1",
			worldId: "world-1",
			channelId: "channel-1",
		};

		const record = await service.draftFollowup(runtime(), params);

		expect(record).toMatchObject({ ...params, draftId: "followup-1" });
		expect(service.getStore().getDraft("followup-1")).toEqual(record);
		await expect(
			service.draftFollowup(runtime(), {
				...params,
				source: "discord",
			}),
		).rejects.toThrow('No adapter registered for source "discord"');
	});
});

describe("TriageService immediate delivery", () => {
	it("rejects missing drafts, unavailable adapters, and empty provider receipts", async () => {
		const service = new TriageService(new MessageRefStore());
		await expect(service.sendDraft(runtime(), "missing")).rejects.toMatchObject(
			{
				code: "MESSAGE_DRAFT_NOT_FOUND",
			},
		);

		service.getStore().saveDraft(draft());
		service.register(adapter("gmail", { isAvailable: () => false }));
		await expect(service.sendDraft(runtime(), "draft-1")).rejects.toMatchObject(
			{
				code: "MESSAGE_ADAPTER_UNAVAILABLE",
			},
		);

		service.register(
			adapter("gmail", {
				sendDraft: async () => ({ externalId: "  " }),
			}),
		);
		await expect(service.sendDraft(runtime(), "draft-1")).rejects.toMatchObject(
			{
				code: "MESSAGE_PROVIDER_RECEIPT_MISSING",
			},
		);
	});

	it("returns already-sent drafts without contacting the adapter", async () => {
		const sendDraft = vi.fn(async () => ({ externalId: "unexpected" }));
		const service = new TriageService(new MessageRefStore());
		service.register(adapter("gmail", { sendDraft }));
		const sent = draft("sent", {
			sent: true,
			sentExternalId: "provider-existing",
		});
		service.getStore().saveDraft(sent);

		await expect(service.sendDraft(runtime(), "sent")).resolves.toEqual(sent);
		expect(sendDraft).not.toHaveBeenCalled();
	});

	it("collapses concurrent sends and allows a retry after failure", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const sendDraft = vi
			.fn<() => Promise<{ externalId: string }>>()
			.mockImplementationOnce(async () => {
				await gate;
				throw new Error("temporary provider failure");
			})
			.mockResolvedValueOnce({ externalId: "provider-retry" });
		const service = new TriageService(new MessageRefStore());
		service.register(adapter("gmail", { sendDraft }));
		service.getStore().saveDraft(draft());

		const first = service.sendDraft(runtime(), "draft-1");
		const duplicate = service.sendDraft(runtime(), "draft-1");
		release?.();
		await expect(Promise.all([first, duplicate])).rejects.toThrow(
			"temporary provider failure",
		);
		await expect(
			service.sendDraft(runtime(), "draft-1"),
		).resolves.toMatchObject({
			sent: true,
			sentExternalId: "provider-retry",
		});
		expect(sendDraft).toHaveBeenCalledTimes(2);
	});

	it("recreates persisted drafts and maps a provider-local id back to the durable id", async () => {
		const createDraft = vi.fn(async () => ({
			draftId: "provider-local-draft",
			preview: "provider preview",
		}));
		const sendDraft = vi.fn(async () => ({
			externalId: "provider-message-1",
		}));
		const service = new TriageService(new MessageRefStore());
		service.register(adapter("gmail", { createDraft, sendDraft }));
		const snapshot = draft("durable-draft", {
			inReplyToId: "message-1",
			threadId: "thread-1",
			worldId: "world-1",
			channelId: "channel-1",
			metadata: { connector: "gmail" },
		});

		const sent = await service.sendPersistedDraft(runtime(), snapshot);

		expect(createDraft.mock.calls[0]?.[1]).toMatchObject({
			inReplyToId: "message-1",
			metadata: { connector: "gmail" },
		});
		expect(sendDraft).toHaveBeenCalledWith(
			expect.anything(),
			"provider-local-draft",
		);
		expect(sent).toMatchObject({
			draftId: "durable-draft",
			sent: true,
			sentExternalId: "provider-message-1",
		});
		expect(service.getStore().getDraft("durable-draft")).toEqual(sent);
	});

	it("rejects persisted sends when recreation is unavailable or lacks an id", async () => {
		const service = new TriageService(new MessageRefStore());
		service.register(adapter("gmail", { isAvailable: () => false }));
		await expect(
			service.sendPersistedDraft(runtime(), draft()),
		).rejects.toMatchObject({ code: "MESSAGE_ADAPTER_UNAVAILABLE" });

		service.register(
			adapter("gmail", {
				createDraft: async () => ({ draftId: " ", preview: "preview" }),
			}),
		);
		await expect(
			service.sendPersistedDraft(runtime(), draft()),
		).rejects.toMatchObject({
			code: "MESSAGE_PROVIDER_DRAFT_RECEIPT_MISSING",
		});
	});
});
