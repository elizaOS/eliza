/**
 * Behavioral coverage for the messaging-triage barrel: every suite drives the
 * real exports through `./index` — the unified action list the runtime
 * registers, the per-runtime deferred-scheduler and send-policy registries,
 * the default store/service singletons, adapter availability gating with the
 * in-memory search fallback, and structural scoring plus feed ordering.
 * Deterministic — fake runtimes and in-process adapters only.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { IAgentRuntime } from "../../../types/index.ts";
import type {
	DraftRecord,
	DraftRequest,
	ListOptions,
	MessageAdapterCapabilities,
	MessageRef,
	SearchMessagesFilters,
} from "./index";
import {
	__resetDefaultMessageRefStoreForTests,
	__resetDefaultTriageServiceForTests,
	__resetSendPolicyForTests,
	BaseMessageAdapter,
	DEFAULT_CONTACT_WEIGHT,
	filterInMemory,
	getDefaultMessageRefStore,
	getDefaultTriageService,
	getDeferredMessageScheduler,
	getSendPolicy,
	MessageRefStore,
	messagingTriageActions,
	NotYetImplementedError,
	rankScored,
	registerDeferredMessageScheduler,
	registerSendPolicy,
	resetMissingServiceWarning,
	resolveContactWeight,
	scoreMessage,
	scoreMessages,
	TriageService,
} from "./index";

const runtimeStub = {
	getService: () => null,
} as unknown as IAgentRuntime;

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

function draftRecord(overrides: Partial<DraftRecord>): DraftRecord {
	return {
		draftId: "draft-1",
		source: "gmail",
		to: [{ identifier: "owner@example.com" }],
		body: "hello there",
		preview: "hello…",
		createdAtMs: 1_000,
		sent: false,
		...overrides,
	};
}

function relationshipsRuntime(
	findByHandle: (source: string, identifier: string) => Promise<unknown>,
): IAgentRuntime {
	return {
		getService: () => ({ findByHandle }),
	} as unknown as IAgentRuntime;
}

class UnavailableAdapter extends BaseMessageAdapter {
	readonly source = "telegram" as const;
	isAvailable(): boolean {
		return false;
	}
}

class ListOnlyAdapter extends BaseMessageAdapter {
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

describe("messagingTriageActions", () => {
	it("registers exactly the unified MESSAGE action", () => {
		expect(messagingTriageActions).toHaveLength(1);
		const [action] = messagingTriageActions;
		expect(action.name).toBe("MESSAGE");
		expect(typeof action.handler).toBe("function");
		expect(typeof action.validate).toBe("function");
	});
});

describe("deferred-message scheduler registry", () => {
	it("returns null when no scheduler is registered for the runtime", () => {
		expect(getDeferredMessageScheduler(runtimeStub)).toBeNull();
	});

	it("returns the registered scheduler and unregisters via the disposer", () => {
		const runtime = {} as IAgentRuntime;
		const scheduler = {
			schedule: async () => {
				throw new Error("not used");
			},
		};
		const unregister = registerDeferredMessageScheduler(runtime, scheduler);
		expect(getDeferredMessageScheduler(runtime)).toBe(scheduler);
		unregister();
		expect(getDeferredMessageScheduler(runtime)).toBeNull();
	});

	it("refuses duplicate registration instead of silently replacing", () => {
		const runtime = {} as IAgentRuntime;
		const scheduler = {
			schedule: async () => {
				throw new Error("not used");
			},
		};
		registerDeferredMessageScheduler(runtime, scheduler);
		let thrown: unknown;
		try {
			registerDeferredMessageScheduler(runtime, scheduler);
		} catch (error) {
			thrown = error;
		}
		expect(thrown).toBeInstanceOf(Error);
		expect((thrown as { code?: string }).code).toBe(
			"DEFERRED_MESSAGE_SCHEDULER_DUPLICATE",
		);
	});

	it("a stale disposer must not remove a newer registration", () => {
		const runtime = {} as IAgentRuntime;
		const first = {
			schedule: async () => {
				throw new Error("not used");
			},
		};
		const second = {
			schedule: async () => {
				throw new Error("not used");
			},
		};
		const staleUnregister = registerDeferredMessageScheduler(runtime, first);
		staleUnregister();
		const activeUnregister = registerDeferredMessageScheduler(runtime, second);
		staleUnregister();
		expect(getDeferredMessageScheduler(runtime)).toBe(second);
		activeUnregister();
		expect(getDeferredMessageScheduler(runtime)).toBeNull();
	});
});

describe("send-policy registry", () => {
	it("returns null until a policy is registered and reset clears it", () => {
		const runtime = {} as IAgentRuntime;
		expect(getSendPolicy(runtime)).toBeNull();
		const policy = {
			shouldRequireApproval: async () => false,
			enqueueApproval: async () => ({
				requestId: "r",
				preview: "p",
			}),
		};
		registerSendPolicy(runtime, policy);
		expect(getSendPolicy(runtime)).toBe(policy);
		__resetSendPolicyForTests(runtime);
		expect(getSendPolicy(runtime)).toBeNull();
	});
});

describe("default message-ref store singleton", () => {
	beforeEach(() => {
		__resetDefaultMessageRefStoreForTests();
	});

	it("hands out the same instance until reset produces a fresh one", () => {
		const first = getDefaultMessageRefStore();
		expect(getDefaultMessageRefStore()).toBe(first);
		__resetDefaultMessageRefStoreForTests();
		expect(getDefaultMessageRefStore()).not.toBe(first);
	});

	it("round-trips messages by id and external id through the exported class", () => {
		const store = new MessageRefStore();
		const ref = messageRef({
			id: "m1",
			externalId: "ext-1",
			source: "whatsapp",
		});
		store.saveMessage(ref);
		expect(store.getMessage("m1")).toEqual(ref);
		expect(store.getMessage("missing")).toBeNull();
		expect(store.findByExternalId("whatsapp", "ext-1")).toEqual(ref);
		expect(store.findByExternalId("gmail", "ext-1")).toBeNull();
	});

	it("addTag is idempotent and removeTag of an absent tag leaves the ref alone", () => {
		const store = new MessageRefStore();
		store.saveMessage(messageRef({ id: "m1" }));
		const tagged = store.addTag("m1", "billing");
		expect(tagged?.tags).toEqual(["billing"]);
		expect(store.addTag("m1", "billing")?.tags).toEqual(["billing"]);
		const untagged = tagged ? store.removeTag("m1", "absent") : null;
		expect(untagged?.tags).toEqual(tagged?.tags);
		expect(store.addTag("missing", "billing")).toBeNull();
		expect(store.removeTag("missing", "billing")).toBeNull();
	});

	it("markDraftSent reports null for an unknown draft and stamps a known one", () => {
		const store = new MessageRefStore();
		expect(store.markDraftSent("nope", "ext-9")).toBeNull();
		store.saveDraft(draftRecord({ draftId: "d1" }));
		const sent = store.markDraftSent("d1", "ext-9");
		expect(sent?.sent).toBe(true);
		expect(sent?.sentExternalId).toBe("ext-9");
	});
});

describe("triage service singleton", () => {
	beforeEach(() => {
		__resetDefaultTriageServiceForTests();
	});

	it("hands out the same instance until reset produces a fresh one", () => {
		const first = getDefaultTriageService();
		expect(getDefaultTriageService()).toBe(first);
		__resetDefaultTriageServiceForTests();
		expect(getDefaultTriageService()).not.toBe(first);
	});

	it("routes registered adapters by source", () => {
		const service = new TriageService(new MessageRefStore());
		const adapter = new ListOnlyAdapter([]);
		service.register(adapter);
		expect(service.getAdapter("gmail")).toBe(adapter);
		expect(service.getAdapter("discord")).toBeUndefined();
		expect(service.listRegisteredSources()).toEqual(["gmail"]);
	});
});

describe("BaseMessageAdapter availability gating", () => {
	it("degrades reads and manages and refuses drafts when unavailable", async () => {
		const adapter = new UnavailableAdapter();
		await expect(adapter.listMessages(runtimeStub, {})).resolves.toEqual([]);
		await expect(adapter.getMessage(runtimeStub, "m1")).resolves.toBeNull();
		const managed = await adapter.manageMessage(runtimeStub, "m1", {
			kind: "archive",
		});
		expect(managed.ok).toBe(false);
		expect(managed.reason).toContain("unavailable");
		const request: DraftRequest = {
			source: "telegram",
			to: [{ identifier: "owner@example.com" }],
			body: "hi",
		};
		await expect(
			adapter.createDraft(runtimeStub, request),
		).rejects.toBeInstanceOf(NotYetImplementedError);
	});

	it("falls back to list-plus-filter for search when native search is absent", async () => {
		const adapter = new ListOnlyAdapter([
			messageRef({ id: "hit", snippet: "lunch on saturday" }),
			messageRef({ id: "miss", snippet: "quarterly numbers" }),
		]);
		const filters: SearchMessagesFilters = { content: "LUNCH" };
		await expect(adapter.searchMessages(runtimeStub, filters)).resolves.toEqual(
			[expect.objectContaining({ id: "hit" })],
		);
	});
});

describe("filterInMemory", () => {
	const refs = [
		messageRef({
			id: "a",
			source: "gmail",
			subject: "Lunch plans",
			snippet: "see you saturday",
			receivedAtMs: 2_000,
			tags: ["personal"],
			worldId: "w1",
			channelId: "c1",
			from: { identifier: "Alice", displayName: "Alice A" },
		}),
		messageRef({
			id: "b",
			source: "telegram",
			subject: "Invoice",
			snippet: "payment overdue",
			receivedAtMs: 3_000,
			tags: ["billing", "urgent"],
		}),
	];

	it("matches content across subject/snippet/body case-insensitively", () => {
		expect(
			filterInMemory(refs, { content: " lunch " }).map((m) => m.id),
		).toEqual(["a"]);
		expect(
			filterInMemory(refs, { content: "OVERDUE" }).map((m) => m.id),
		).toEqual(["b"]);
	});

	it("AND-matches tags, bounds receivedAtMs, and narrows by sender", () => {
		expect(
			filterInMemory(refs, { tags: ["billing", "urgent"] }).map((m) => m.id),
		).toEqual(["b"]);
		expect(filterInMemory(refs, { sinceMs: 2_500 }).map((m) => m.id)).toEqual([
			"b",
		]);
		expect(filterInMemory(refs, { untilMs: 2_500 }).map((m) => m.id)).toEqual([
			"a",
		]);
		expect(
			filterInMemory(refs, { sender: { identifier: "alice" } }).map(
				(m) => m.id,
			),
		).toEqual(["a"]);
		expect(
			filterInMemory(refs, { sender: { displayName: "alice a" } }).map(
				(m) => m.id,
			),
		).toEqual(["a"]);
		expect(filterInMemory(refs, { worldIds: ["w1"] }).map((m) => m.id)).toEqual(
			["a"],
		);
		expect(
			filterInMemory(refs, { channelIds: ["c1"] }).map((m) => m.id),
		).toEqual(["a"]);
		expect(
			filterInMemory(refs, { sources: ["telegram"] }).map((m) => m.id),
		).toEqual(["b"]);
	});
});

describe("triage engine structural scoring", () => {
	beforeEach(() => {
		resetMissingServiceWarning();
	});

	it("uses the default contact weight when no relationships service exists", async () => {
		const result = await resolveContactWeight(runtimeStub, "gmail", "a@x.com");
		expect(result.weight).toBe(DEFAULT_CONTACT_WEIGHT);
		expect(result.contact).toBeNull();
	});

	it("picks the heaviest known category and ignores unknown ones", async () => {
		const runtime = relationshipsRuntime(async () => ({
			categories: ["stranger", " FAMILY ", "not-a-real-category"],
		}));
		const result = await resolveContactWeight(runtime, "gmail", "mom@x.com");
		expect(result.weight).toBeGreaterThan(DEFAULT_CONTACT_WEIGHT);
		expect(result.weight).toBe(1.0);

		const unknownOnly = relationshipsRuntime(async () => ({
			categories: ["not-a-real-category"],
		}));
		const fallback = await resolveContactWeight(
			unknownOnly,
			"gmail",
			"who@x.com",
		);
		expect(fallback.weight).toBe(DEFAULT_CONTACT_WEIGHT);
	});

	it("falls back to the default weight when no contact matches", async () => {
		const runtime = relationshipsRuntime(async () => null);
		const result = await resolveContactWeight(runtime, "gmail", "ghost@x.com");
		expect(result.weight).toBe(DEFAULT_CONTACT_WEIGHT);
		expect(result.contact).toBeNull();
	});

	it("flags threads the user previously replied in using ctx.nowMs", async () => {
		const scored = await scoreMessage(
			runtimeStub,
			messageRef({ id: "m1", threadId: "t1" }),
			{ userRepliedThreadIds: new Set(["t1"]), nowMs: 42 },
		);
		expect(scored).toEqual({
			contactWeight: DEFAULT_CONTACT_WEIGHT,
			userRepliedInThread: true,
			scoredAt: 42,
		});

		const unflagged = await scoreMessage(
			runtimeStub,
			messageRef({ id: "m2", threadId: "t2" }),
			{ userRepliedThreadIds: new Set(["t1"]) },
		);
		expect(unflagged.userRepliedInThread).toBe(false);

		const noThread = await scoreMessage(runtimeStub, messageRef({ id: "m3" }), {
			userRepliedThreadIds: new Set(["t1"]),
		});
		expect(noThread.userRepliedInThread).toBe(false);
	});

	it("attaches a triage score to every message without reordering", async () => {
		const scored = await scoreMessages(runtimeStub, [
			messageRef({ id: "first", threadId: "t1" }),
			messageRef({ id: "second", threadId: "t2" }),
		]);
		expect(scored.map((m) => m.id)).toEqual(["first", "second"]);
		for (const ref of scored) {
			expect(ref.triageScore?.contactWeight).toBe(DEFAULT_CONTACT_WEIGHT);
			expect(ref.triageScore?.userRepliedInThread).toBe(false);
		}
	});

	it("orders newest first, then contact weight, then id; non-finite stamps sink", () => {
		const ranked = rankScored([
			messageRef({
				id: "old-scored",
				receivedAtMs: Number.NaN,
				triageScore: {
					contactWeight: 1,
					userRepliedInThread: false,
					scoredAt: 0,
				},
			}),
			messageRef({ id: "mid", receivedAtMs: 1_000 }),
			messageRef({
				id: "new-heavy",
				receivedAtMs: 2_000,
				triageScore: {
					contactWeight: 0.7,
					userRepliedInThread: false,
					scoredAt: 0,
				},
			}),
			messageRef({
				id: "new-light",
				receivedAtMs: 2_000,
				triageScore: {
					contactWeight: 0.4,
					userRepliedInThread: false,
					scoredAt: 0,
				},
			}),
			messageRef({ id: "tie-a", receivedAtMs: 1_000 }),
			messageRef({ id: "tie-b", receivedAtMs: 1_000 }),
		]);
		expect(ranked.map((m) => m.id)).toEqual([
			"new-heavy",
			"new-light",
			"mid",
			"tie-a",
			"tie-b",
			"old-scored",
		]);
	});

	it("places unscored messages at the default weight between scored peers", () => {
		const at = 5_000;
		const ranked = rankScored([
			messageRef({
				id: "acquaintance",
				receivedAtMs: at,
				triageScore: {
					contactWeight: 0.4,
					userRepliedInThread: false,
					scoredAt: 0,
				},
			}),
			messageRef({ id: "unscored", receivedAtMs: at }),
			messageRef({
				id: "professional",
				receivedAtMs: at,
				triageScore: {
					contactWeight: 0.7,
					userRepliedInThread: false,
					scoredAt: 0,
				},
			}),
		]);
		expect(ranked.map((m) => m.id)).toEqual([
			"professional",
			"unscored",
			"acquaintance",
		]);
	});
});

describe("exported error contract", () => {
	it("NotYetImplementedError carries its feature in the message and name", () => {
		const error = new NotYetImplementedError("scheduleSend");
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("NotYetImplementedError");
		expect(error.message).toBe("NotYetImplemented: scheduleSend");
	});
});
