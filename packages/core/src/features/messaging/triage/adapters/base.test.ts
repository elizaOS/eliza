/**
 * Exercises the base messaging adapter's availability gates, default hooks,
 * search dispatch, and lossless in-memory filtering with concrete adapters.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../../../logger.ts";
import type { IAgentRuntime } from "../../../../types/index.ts";
import type {
	DraftRequest,
	ListOptions,
	ManageOperation,
	MessageAdapterCapabilities,
	MessageRef,
	MessageSource,
	ReadMessageRequest,
	SearchMessagesFilters,
} from "../types.ts";
import { BaseMessageAdapter, filterInMemory } from "./base.ts";

const runtime = {} as IAgentRuntime;

const makeMessage = (
	id: string,
	overrides: Partial<MessageRef> = {},
): MessageRef => ({
	id,
	source: "discord",
	externalId: `external-${id}`,
	from: { identifier: "sender@example.com", displayName: "Ada Lovelace" },
	to: [],
	subject: "Project update",
	snippet: "The build is ready",
	body: "Review the attached report",
	receivedAtMs: 1_000,
	hasAttachments: false,
	isRead: false,
	worldId: "world-1",
	channelId: "channel-1",
	tags: ["work", "review"],
	...overrides,
});

class UnavailableAdapter extends BaseMessageAdapter {
	readonly source: MessageSource = "discord";

	isAvailable(): boolean {
		return false;
	}
}

class AvailableDefaultAdapter extends BaseMessageAdapter {
	readonly source: MessageSource = "discord";

	isAvailable(): boolean {
		return true;
	}

	callNativeSearch(filters: SearchMessagesFilters): Promise<MessageRef[]> {
		return this.searchMessagesImpl(runtime, filters);
	}
}

class RecordingAdapter extends BaseMessageAdapter {
	readonly source: MessageSource = "discord";
	listOptions?: ListOptions;
	getId?: string;
	readRequest?: ReadMessageRequest;
	searchFilters?: SearchMessagesFilters;
	manageCall?: { messageId: string; op: ManageOperation };
	draft?: DraftRequest;
	draftId?: string;
	schedule?: { draftId: string; sendAtMs: number };

	constructor(
		private readonly nativeSearch: boolean,
		private readonly messages: MessageRef[],
	) {
		super();
	}

	isAvailable(): boolean {
		return true;
	}

	override capabilities(): MessageAdapterCapabilities {
		return { ...super.capabilities(), search: this.nativeSearch };
	}

	protected override async listMessagesImpl(
		_runtime: IAgentRuntime,
		opts: ListOptions,
	): Promise<MessageRef[]> {
		this.listOptions = opts;
		return this.messages;
	}

	protected override async getMessageImpl(
		_runtime: IAgentRuntime,
		id: string,
	): Promise<MessageRef | null> {
		this.getId = id;
		return this.messages.find((message) => message.id === id) ?? null;
	}

	protected override async readMessageImpl(
		_runtime: IAgentRuntime,
		request: ReadMessageRequest,
	) {
		this.readRequest = request;
		return {
			text: "complete body",
			readView: {
				reference: "message-ref",
				revision: "revision-1",
				unit: "characters" as const,
				offset: 0,
				limit: 13,
				total: 13,
				hasMore: false,
			},
		};
	}

	protected override async searchMessagesImpl(
		_runtime: IAgentRuntime,
		filters: SearchMessagesFilters,
	): Promise<MessageRef[]> {
		this.searchFilters = filters;
		return [makeMessage("native")];
	}

	protected override async manageMessageImpl(
		_runtime: IAgentRuntime,
		messageId: string,
		op: ManageOperation,
	) {
		this.manageCall = { messageId, op };
		return { ok: true };
	}

	protected override async createDraftImpl(
		_runtime: IAgentRuntime,
		draft: DraftRequest,
	) {
		this.draft = draft;
		return { draftId: "draft-1", preview: draft.body };
	}

	protected override async sendDraftImpl(
		_runtime: IAgentRuntime,
		draftId: string,
	) {
		this.draftId = draftId;
		return { externalId: "sent-1" };
	}

	protected override async scheduleSendImpl(
		_runtime: IAgentRuntime,
		draftId: string,
		sendAtMs: number,
	) {
		this.schedule = { draftId, sendAtMs };
		return { scheduledId: "scheduled-1" };
	}
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("BaseMessageAdapter", () => {
	it("advertises the conservative default capability profile", () => {
		expect(new UnavailableAdapter().capabilities()).toEqual({
			list: false,
			search: false,
			manage: {},
			send: {},
			worlds: "single",
			channels: "none",
		});
	});

	it("returns unavailable read results and logs the condition only once", async () => {
		const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
		const adapter = new UnavailableAdapter();

		await expect(adapter.listMessages(runtime, { limit: 10 })).resolves.toEqual(
			[],
		);
		await expect(adapter.getMessage(runtime, "missing")).resolves.toBeNull();
		await expect(adapter.searchMessages(runtime, {})).resolves.toEqual([]);
		await expect(
			adapter.manageMessage(runtime, "missing", { kind: "archive" }),
		).resolves.toEqual({ ok: false, reason: "discord adapter unavailable" });
		expect(info).toHaveBeenCalledOnce();
		expect(info).toHaveBeenCalledWith(
			"[MessagingTriage:discord] adapter unavailable (underlying plugin not registered); returning empty list",
		);
	});

	it("rejects unavailable body reads and draft lifecycle operations", async () => {
		const adapter = new UnavailableAdapter();

		await expect(
			adapter.readMessage(runtime, { messageId: "message-1" }),
		).rejects.toThrow(
			"[MessagingTriage:discord] adapter unavailable during message read",
		);
		await expect(
			adapter.createDraft(runtime, {
				source: "discord",
				to: [{ identifier: "recipient" }],
				body: "hello",
			}),
		).rejects.toThrow(
			"NotYetImplemented: discord adapter is unavailable for createDraft",
		);
		await expect(adapter.sendDraft(runtime, "draft-1")).rejects.toThrow(
			"NotYetImplemented: discord adapter is unavailable for sendDraft",
		);
		await expect(
			adapter.scheduleSend(runtime, "draft-1", 2_000),
		).rejects.toThrow(
			"NotYetImplemented: discord adapter is unavailable for scheduleSend",
		);
	});

	it("delegates available list, get, read, manage, and draft operations", async () => {
		const message = makeMessage("message-1");
		const adapter = new RecordingAdapter(false, [message]);
		const readRequest = { messageId: message.id, offset: 0, limit: 13 };
		const draft = {
			source: "discord" as const,
			to: [{ identifier: "recipient" }],
			body: "hello",
		};

		await expect(adapter.listMessages(runtime, { limit: 1 })).resolves.toEqual([
			message,
		]);
		await expect(adapter.getMessage(runtime, message.id)).resolves.toBe(
			message,
		);
		await expect(
			adapter.readMessage(runtime, readRequest),
		).resolves.toMatchObject({
			text: "complete body",
			readView: { hasMore: false },
		});
		await expect(
			adapter.manageMessage(runtime, message.id, {
				kind: "mark_read",
				read: true,
			}),
		).resolves.toEqual({ ok: true });
		await expect(adapter.createDraft(runtime, draft)).resolves.toEqual({
			draftId: "draft-1",
			preview: "hello",
		});
		await expect(adapter.sendDraft(runtime, "draft-1")).resolves.toEqual({
			externalId: "sent-1",
		});
		await expect(
			adapter.scheduleSend(runtime, "draft-1", 2_000),
		).resolves.toEqual({ scheduledId: "scheduled-1" });

		expect(adapter.listOptions).toEqual({ limit: 1 });
		expect(adapter.getId).toBe(message.id);
		expect(adapter.readRequest).toBe(readRequest);
		expect(adapter.manageCall).toEqual({
			messageId: message.id,
			op: { kind: "mark_read", read: true },
		});
		expect(adapter.draft).toBe(draft);
		expect(adapter.draftId).toBe("draft-1");
		expect(adapter.schedule).toEqual({ draftId: "draft-1", sendAtMs: 2_000 });
	});

	it("uses native search when the adapter advertises it", async () => {
		const adapter = new RecordingAdapter(true, [makeMessage("listed")]);
		const filters = { content: "native", limit: 2 };

		await expect(adapter.searchMessages(runtime, filters)).resolves.toEqual([
			expect.objectContaining({ id: "native" }),
		]);
		expect(adapter.searchFilters).toBe(filters);
		expect(adapter.listOptions).toBeUndefined();
	});

	it("falls back to list and in-memory filtering without native search", async () => {
		const matching = makeMessage("matching", { snippet: "Needle found" });
		const adapter = new RecordingAdapter(false, [
			makeMessage("other", { snippet: "unrelated" }),
			matching,
		]);
		const filters = {
			content: "needle",
			sinceMs: 500,
			untilMs: 1_500,
			limit: 7,
			worldIds: ["world-1"],
			channelIds: ["channel-1"],
		};

		await expect(adapter.searchMessages(runtime, filters)).resolves.toEqual([
			matching,
		]);
		expect(adapter.listOptions).toEqual({
			sinceMs: 500,
			limit: 7,
			worldIds: ["world-1"],
			channelIds: ["channel-1"],
		});
		expect(adapter.searchFilters).toBeUndefined();
	});

	it("uses explicit not-implemented defaults for available adapter hooks", async () => {
		const adapter = new AvailableDefaultAdapter();

		await expect(adapter.listMessages(runtime, {})).rejects.toThrow(
			"NotYetImplemented: discord adapter does not implement listMessages",
		);
		await expect(adapter.getMessage(runtime, "message-1")).rejects.toThrow(
			"NotYetImplemented: discord adapter does not implement getMessage",
		);
		await expect(
			adapter.readMessage(runtime, { messageId: "message-1" }),
		).rejects.toThrow(
			"NotYetImplemented: discord adapter does not implement readMessage",
		);
		expect(() => adapter.callNativeSearch({})).toThrow(
			"NotYetImplemented: discord adapter does not implement native searchMessages",
		);
		await expect(
			adapter.manageMessage(runtime, "message-1", { kind: "archive" }),
		).resolves.toEqual({
			ok: false,
			reason: "discord adapter does not support manage operations",
		});
		await expect(
			adapter.createDraft(runtime, {
				source: "discord",
				to: [],
				body: "hello",
			}),
		).rejects.toThrow(
			"NotYetImplemented: discord adapter does not support draft creation",
		);
		await expect(adapter.sendDraft(runtime, "draft-1")).rejects.toThrow(
			"NotYetImplemented: discord adapter does not support draft delivery",
		);
		await expect(
			adapter.scheduleSend(runtime, "draft-1", 2_000),
		).rejects.toThrow(
			"NotYetImplemented: discord adapter does not support provider-native deferred delivery",
		);
	});
});

describe("filterInMemory", () => {
	it("preserves empty, single-item, and tied input ordering", () => {
		const first = makeMessage("first", { receivedAtMs: 1_000 });
		const second = makeMessage("second", { receivedAtMs: 1_000 });

		expect(filterInMemory([], {})).toEqual([]);
		expect(filterInMemory([first], {})).toEqual([first]);
		expect(filterInMemory([second, first], {})).toEqual([second, first]);
	});

	it("filters by source and requires configured world and channel membership", () => {
		const matching = makeMessage("matching");
		const messages = [
			matching,
			makeMessage("source", { source: "gmail" }),
			makeMessage("world", { worldId: "world-2" }),
			makeMessage("missing-world", { worldId: undefined }),
			makeMessage("channel", { channelId: "channel-2" }),
			makeMessage("missing-channel", { channelId: undefined }),
		];

		expect(
			filterInMemory(messages, {
				sources: ["discord"],
				worldIds: ["world-1"],
				channelIds: ["channel-1"],
			}),
		).toEqual([matching]);
	});

	it("treats since and until timestamps as inclusive boundaries", () => {
		const before = makeMessage("before", { receivedAtMs: 999 });
		const since = makeMessage("since", { receivedAtMs: 1_000 });
		const until = makeMessage("until", { receivedAtMs: 2_000 });
		const after = makeMessage("after", { receivedAtMs: 2_001 });

		expect(
			filterInMemory([before, since, until, after], {
				sinceMs: 1_000,
				untilMs: 2_000,
			}),
		).toEqual([since, until]);
	});

	it("matches sender identifier exactly and display name by substring", () => {
		const matching = makeMessage("matching");
		const wrongId = makeMessage("wrong-id", {
			from: { identifier: "other@example.com", displayName: "Ada Lovelace" },
		});
		const missingName = makeMessage("missing-name", {
			from: { identifier: "sender@example.com" },
		});

		expect(
			filterInMemory([wrongId, missingName, matching], {
				sender: {
					identifier: "SENDER@EXAMPLE.COM",
					displayName: "LOVE",
				},
			}),
		).toEqual([matching]);
	});

	it("requires every requested tag and treats an empty tag filter as unrestricted", () => {
		const allTags = makeMessage("all-tags", { tags: ["work", "review"] });
		const oneTag = makeMessage("one-tag", { tags: ["work"] });
		const noTags = makeMessage("no-tags", { tags: undefined });

		expect(
			filterInMemory([allTags, oneTag, noTags], { tags: ["work", "review"] }),
		).toEqual([allTags]);
		expect(filterInMemory([allTags, oneTag, noTags], { tags: [] })).toEqual([
			allTags,
			oneTag,
			noTags,
		]);
	});

	it("matches trimmed content across subject, snippet, and body", () => {
		const subject = makeMessage("subject", {
			subject: "Quarterly NEEDLE",
			snippet: "none",
			body: undefined,
		});
		const snippet = makeMessage("snippet", {
			subject: undefined,
			snippet: "Needle in summary",
			body: undefined,
		});
		const body = makeMessage("body", {
			subject: undefined,
			snippet: "none",
			body: "needle in details",
		});
		const unrelated = makeMessage("unrelated", {
			subject: undefined,
			snippet: "none",
			body: undefined,
		});

		expect(
			filterInMemory([subject, snippet, body, unrelated], {
				content: "  NeEdLe  ",
			}),
		).toEqual([subject, snippet, body]);
		expect(filterInMemory([unrelated], { content: "   " })).toEqual([
			unrelated,
		]);
	});

	it("applies all predicates together without enforcing the adapter-level limit", () => {
		const first = makeMessage("first");
		const second = makeMessage("second");
		const rejected = makeMessage("rejected", { tags: ["personal"] });

		expect(
			filterInMemory([first, rejected, second], {
				sources: ["discord"],
				worldIds: ["world-1"],
				channelIds: ["channel-1"],
				sender: { identifier: "sender@example.com", displayName: "ada" },
				content: "build",
				tags: ["work"],
				sinceMs: 1_000,
				untilMs: 1_000,
				limit: 1,
			}),
		).toEqual([first, second]);
	});
});
