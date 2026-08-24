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
		const refs = Array.from({ length: 5_001 }, (_, index) =>
			message(`route-${index}`, "gmail", { receivedAtMs: index }),
		);
		service.register(
			adapter("gmail", {
				listMessages: async () => refs,
			}),
		);

		await service.triage(runtime(), { sources: ["gmail"], nowMs: 10_000 });

		expect(service.getAdapterForMessage("route-0")).toBeUndefined();
		expect(service.getAdapterForMessage("route-5000")).toBe(
			service.getAdapter("gmail"),
		);
		expect(store.listMessages()).toHaveLength(5_000);
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

describe("TriageService sweep scoring and partial failure", () => {
	it("sweeps every registered source by default and persists scored messages", async () => {
		const store = new MessageRefStore();
		const service = new TriageService(store);
		service.register(
			adapter("gmail", {
				listMessages: async () => [
					message("newer", "gmail", { receivedAtMs: 2_000 }),
				],
			}),
		);
		service.register(
			adapter("discord", {
				listMessages: async () => [
					message("older", "discord", { receivedAtMs: 1_000 }),
				],
			}),
		);

		const refs = await service.triage(runtime());

		expect(refs.map(({ id }) => id)).toEqual(["newer", "older"]);
		expect(store.listMessages()).toHaveLength(2);
		expect(store.getMessage("newer")?.triageScore?.scoredAt).toBeGreaterThan(0);
	});

	it("isolates a failing source and rethrows only when nothing succeeded", async () => {
		const mixed = new TriageService(new MessageRefStore());
		mixed.register(
			adapter("gmail", {
				listMessages: async () => {
					throw new Error("gmail boom");
				},
			}),
		);
		mixed.register(
			adapter("discord", {
				listMessages: async () => [message("survivor", "discord")],
			}),
		);
		const refs = await mixed.triage(runtime(), {
			sources: ["gmail", "discord"],
		});
		expect(refs.map(({ id }) => id)).toEqual(["survivor"]);

		const doomed = new TriageService(new MessageRefStore());
		doomed.register(
			adapter("gmail", {
				listMessages: async () => {
					throw new Error("gmail boom");
				},
			}),
		);
		doomed.register(
			adapter("discord", {
				listMessages: async () => {
					throw new Error("discord boom");
				},
			}),
		);
		await expect(
			doomed.triage(runtime(), { sources: ["gmail", "discord"] }),
		).rejects.toThrow("gmail boom");
	});

	it("forwards list options verbatim to each adapter sweep", async () => {
		const listMessages = vi.fn(async () => [message("listed")]);
		const service = new TriageService(new MessageRefStore());
		service.register(adapter("gmail", { listMessages }));

		await service.triage(runtime(), {
			sources: ["gmail"],
			sinceMs: 10,
			limit: 5,
			worldIds: ["world-1"],
			channelIds: ["channel-1"],
		});

		expect(listMessages).toHaveBeenCalledWith(expect.anything(), {
			sinceMs: 10,
			limit: 5,
			worldIds: ["world-1"],
			channelIds: ["channel-1"],
		});
	});
});

describe("TriageService search receipts and fallback filtering", () => {
	it("reports failed sources in the receipt while surviving sources still return hits", async () => {
		const service = new TriageService(new MessageRefStore());
		service.register(
			adapter("gmail", {
				searchMessages: async () => [message("hit")],
			}),
		);
		service.register(
			adapter("discord", {
				searchMessages: async () => {
					throw new Error("discord boom");
				},
			}),
		);

		const result = await service.searchWithReceipt(runtime(), {
			sources: ["gmail", "discord"],
			content: "message",
		});

		expect(result.refs.map(({ id }) => id)).toEqual(["hit"]);
		expect(result.receipt).toMatchObject({
			requested: ["gmail", "discord"],
			succeeded: ["gmail"],
			failed: ["discord"],
		});

		const doomed = new TriageService(new MessageRefStore());
		doomed.register(
			adapter("gmail", {
				searchMessages: async () => {
					throw new Error("gmail boom");
				},
			}),
		);
		await expect(
			doomed.searchWithReceipt(runtime(), {
				sources: ["gmail"],
				content: "message",
			}),
		).rejects.toThrow("gmail boom");
	});

	it("probes one past a requested cap so exact fits report hasMore false", async () => {
		const searchMessages = vi.fn(async () => [
			message("first", "gmail", { receivedAtMs: 2 }),
			message("second", "gmail", { receivedAtMs: 1 }),
		]);
		const service = new TriageService(new MessageRefStore());
		service.register(adapter("gmail", { searchMessages }));

		const result = await service.searchWithReceipt(runtime(), {
			content: "message",
			limit: 2,
		});

		expect(searchMessages.mock.calls[0]?.[1]).toMatchObject({ limit: 3 });
		expect(result.refs.map(({ id }) => id)).toEqual(["first", "second"]);
		expect(result.receipt).toMatchObject({ limit: 2, hasMore: false });
	});

	it("falls back to listMessages and in-memory filtering without native search", async () => {
		const listMessages = vi.fn(async () => [
			message("alpha-old", "gmail", {
				snippet: "alpha plans",
				receivedAtMs: 1_000,
			}),
			message("beta-new", "gmail", {
				snippet: "beta notes",
				receivedAtMs: 3_000,
			}),
			message("alpha-new", "gmail", {
				snippet: "alpha recap",
				receivedAtMs: 2_000,
			}),
		]);
		const service = new TriageService(new MessageRefStore());
		service.register(adapter("gmail", { listMessages }));

		const result = await service.searchWithReceipt(runtime(), {
			content: "ALPHA",
		});

		expect(listMessages).toHaveBeenCalledTimes(1);
		expect(result.refs.map(({ id }) => id)).toEqual(["alpha-new", "alpha-old"]);
		expect(result.receipt.succeeded).toEqual(["gmail"]);
	});
});

describe("TriageService managed routing and tag delegation", () => {
	it("resolves the adapter from stored metadata when no hint is supplied", async () => {
		const manageMessage = vi.fn(async () => ({ ok: true }));
		const service = new TriageService(new MessageRefStore());
		service.register(adapter("discord", { manageMessage }));
		service.getStore().saveMessage(message("managed", "discord"));

		await expect(
			service.manage(runtime(), "managed", { kind: "archive" }),
		).resolves.toEqual({ ok: true });
		expect(manageMessage).toHaveBeenCalledWith(expect.anything(), "managed", {
			kind: "archive",
		});
	});

	it("applies tag_add locally even when delegating to a managing adapter", async () => {
		const manageMessage = vi.fn(async () => ({ ok: true }));
		const service = new TriageService(new MessageRefStore());
		service.register(adapter("gmail", { manageMessage }));
		service.getStore().saveMessage(message("managed"));

		await expect(
			service.manage(
				runtime(),
				"managed",
				{ kind: "tag_add", tag: "urgent" },
				{ source: "gmail" },
			),
		).resolves.toEqual({ ok: true });

		expect(service.getStore().getMessage("managed")?.tags).toEqual(["urgent"]);
		expect(manageMessage).toHaveBeenCalledWith(expect.anything(), "managed", {
			kind: "tag_add",
			tag: "urgent",
		});
	});
});

describe("TriageService scheduled delivery", () => {
	function schedulingAdapter(
		scheduleSend: NonNullable<MessageAdapter["scheduleSend"]>,
	): MessageAdapter {
		return adapter("gmail", {
			capabilities: () => ({
				list: true,
				search: false,
				manage: {},
				send: { reply: true, new: true, schedule: true },
				worlds: "single",
				channels: "none",
			}),
			scheduleSend,
		});
	}

	it("rejects scheduling unknown or already-sent drafts", async () => {
		const service = new TriageService(new MessageRefStore());
		await expect(
			service.scheduleDraftSend(runtime(), "missing", 50_000),
		).rejects.toMatchObject({ code: "MESSAGE_DRAFT_NOT_FOUND" });

		service.getStore().saveDraft(draft("sent-draft", { sent: true }));
		await expect(
			service.scheduleDraftSend(runtime(), "sent-draft", 50_000),
		).rejects.toMatchObject({ code: "MESSAGE_DRAFT_ALREADY_SENT" });
	});

	it("records provider-accepted commits once and replays identical requests", async () => {
		const scheduleSend = vi.fn(async () => ({
			scheduledId: "provider-schedule-1",
		}));
		const service = new TriageService(new MessageRefStore());
		service.register(schedulingAdapter(scheduleSend));
		service.getStore().saveDraft(draft());

		const scheduled = await service.scheduleDraftSend(
			runtime(),
			"draft-1",
			50_000,
		);
		expect(scheduled).toMatchObject({
			scheduledForMs: 50_000,
			scheduledId: "provider-schedule-1",
			scheduleCommit: {
				kind: "provider_accepted",
				id: "provider-schedule-1",
				idempotencyKey: "message-native-schedule:gmail:draft-1:50000",
				replayed: false,
			},
		});
		expect(service.getStore().getDraft("draft-1")).toEqual(scheduled);

		const replayed = await service.scheduleDraftSend(
			runtime(),
			"draft-1",
			50_000,
		);
		expect(replayed.scheduleCommit?.replayed).toBe(true);
		expect(replayed.scheduledId).toBe("provider-schedule-1");
		expect(scheduleSend).toHaveBeenCalledTimes(1);
	});

	it("rejects rescheduling a committed draft at a different time", async () => {
		const service = new TriageService(new MessageRefStore());
		service.register(
			schedulingAdapter(async () => ({ scheduledId: "provider-schedule-1" })),
		);
		service.getStore().saveDraft(draft());

		await service.scheduleDraftSend(runtime(), "draft-1", 50_000);
		await expect(
			service.scheduleDraftSend(runtime(), "draft-1", 60_000),
		).rejects.toMatchObject({ code: "MESSAGE_DRAFT_ALREADY_SCHEDULED" });
	});

	it("requires a durable scheduler when the adapter cannot schedule natively", async () => {
		const service = new TriageService(new MessageRefStore());
		service.register(adapter("gmail"));
		service.getStore().saveDraft(draft());

		await expect(
			service.scheduleDraftSend(runtime(), "draft-1", 50_000),
		).rejects.toMatchObject({
			code: "DEFERRED_MESSAGE_SCHEDULER_UNAVAILABLE",
		});
	});

	it("refuses concurrent schedules that specify different delivery times", async () => {
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const scheduleSend = vi.fn(async () => {
			await gate;
			return { scheduledId: "provider-schedule-1" };
		});
		const service = new TriageService(new MessageRefStore());
		service.register(schedulingAdapter(scheduleSend));
		service.getStore().saveDraft(draft());

		const first = service.scheduleDraftSend(runtime(), "draft-1", 50_000);
		await expect(
			service.scheduleDraftSend(runtime(), "draft-1", 60_000),
		).rejects.toMatchObject({ code: "MESSAGE_DRAFT_SCHEDULE_CONFLICT" });
		release?.();
		await expect(first).resolves.toMatchObject({
			scheduledForMs: 50_000,
			scheduledId: "provider-schedule-1",
		});
	});

	it("rejects provider schedules without a usable identifier", async () => {
		const service = new TriageService(new MessageRefStore());
		service.register(schedulingAdapter(async () => ({ scheduledId: "   " })));
		service.getStore().saveDraft(draft());

		await expect(
			service.scheduleDraftSend(runtime(), "draft-1", 50_000),
		).rejects.toMatchObject({
			code: "MESSAGE_PROVIDER_SCHEDULE_RECEIPT_MISSING",
		});
	});
});
