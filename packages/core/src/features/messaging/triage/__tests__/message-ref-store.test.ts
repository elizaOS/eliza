/**
 * Deterministic boundary coverage for MessageRefStore write-recency eviction.
 * The real in-memory store is exercised at its production message and draft
 * capacities without replacing the system under test.
 */

import { describe, expect, it } from "vitest";
import { MessageRefStore } from "../message-ref-store.ts";
import type { DraftRecord, MessageRef } from "../types.ts";

const MESSAGE_CAPACITY = 5000;
const DRAFT_CAPACITY = 2000;

function message(
	index: number,
	overrides: Partial<MessageRef> = {},
): MessageRef {
	return {
		id: `message-${index}`,
		source: "gmail",
		externalId: `external-${index}`,
		from: { identifier: `sender-${index}@example.com` },
		to: [],
		snippet: `message ${index}`,
		receivedAtMs: index,
		hasAttachments: false,
		isRead: false,
		...overrides,
	};
}

function draft(
	index: number,
	overrides: Partial<DraftRecord> = {},
): DraftRecord {
	return {
		draftId: `draft-${index}`,
		source: "gmail",
		to: [{ identifier: `recipient-${index}@example.com` }],
		body: `draft body ${index}`,
		preview: `draft preview ${index}`,
		createdAtMs: index,
		sent: false,
		...overrides,
	};
}

function fillMessages(store: MessageRefStore): void {
	store.saveMessages(
		Array.from({ length: MESSAGE_CAPACITY }, (_, index) => message(index)),
	);
}

function fillMessagesAfter(store: MessageRefStore, firstIndex: number): void {
	store.saveMessages(
		Array.from({ length: MESSAGE_CAPACITY - firstIndex }, (_, offset) =>
			message(firstIndex + offset),
		),
	);
}

function fillDrafts(store: MessageRefStore): void {
	for (let index = 0; index < DRAFT_CAPACITY; index += 1) {
		store.saveDraft(draft(index));
	}
}

describe("MessageRefStore write-recency eviction", () => {
	it("keeps a singly refreshed message and evicts the oldest untouched message", () => {
		const store = new MessageRefStore();
		fillMessages(store);

		store.saveMessage(message(0, { snippet: "fresh message zero" }));
		store.saveMessage(message(MESSAGE_CAPACITY));

		expect(store.getMessage("message-0")?.snippet).toBe("fresh message zero");
		expect(store.getMessage("message-1")).toBeNull();
		expect(store.getMessage(`message-${MESSAGE_CAPACITY}`)).not.toBeNull();
		expect(store.listMessages()).toHaveLength(MESSAGE_CAPACITY);
	});

	it("uses complete batch order and the last duplicate value for recency", () => {
		const store = new MessageRefStore();
		fillMessages(store);

		store.saveMessages([
			message(0, { snippet: "first refresh" }),
			message(MESSAGE_CAPACITY),
			message(0, { snippet: "last refresh" }),
		]);

		const listed = store.listMessages();
		expect(store.getMessage("message-0")?.snippet).toBe("last refresh");
		expect(store.getMessage("message-1")).toBeNull();
		expect(listed).toHaveLength(MESSAGE_CAPACITY);
		expect(listed.slice(-2).map((ref) => ref.id)).toEqual([
			`message-${MESSAGE_CAPACITY}`,
			"message-0",
		]);
	});

	it.each([
		{
			name: "addTag",
			seed: message(0, { tags: ["existing"] }),
			mutate: (store: MessageRefStore) => store.addTag("message-0", "urgent"),
			expectedTags: ["existing", "urgent"],
		},
		{
			name: "removeTag",
			seed: message(0, { tags: ["remove", "keep"] }),
			mutate: (store: MessageRefStore) =>
				store.removeTag("message-0", "remove"),
			expectedTags: ["keep"],
		},
	])(
		"refreshes message recency after $name writes",
		({ seed, mutate, expectedTags }) => {
			const store = new MessageRefStore();
			store.saveMessage(seed);
			fillMessagesAfter(store, 1);

			expect(mutate(store)?.tags).toEqual(expectedTags);
			store.saveMessage(message(MESSAGE_CAPACITY));

			expect(store.getMessage("message-0")?.tags).toEqual(expectedTags);
			expect(store.getMessage("message-1")).toBeNull();
		},
	);

	it("does not refresh message or draft recency on reads or an empty-tag removal", () => {
		const store = new MessageRefStore();
		fillMessages(store);
		fillDrafts(store);

		expect(store.getMessage("message-0")).not.toBeNull();
		expect(store.findByExternalId("gmail", "external-0")).not.toBeNull();
		expect(store.listMessages()).toHaveLength(MESSAGE_CAPACITY);
		expect(store.removeTag("message-0", "absent")).not.toBeNull();
		expect(store.getDraft("draft-0")).not.toBeNull();

		store.saveMessage(message(MESSAGE_CAPACITY));
		store.saveDraft(draft(DRAFT_CAPACITY));

		expect(store.getMessage("message-0")).toBeNull();
		expect(store.getDraft("draft-0")).toBeNull();
	});

	it.each([
		{
			name: "adding an existing tag",
			mutate: (store: MessageRefStore) => store.addTag("message-0", "keep"),
		},
		{
			name: "removing an absent tag from a nonempty tag list",
			mutate: (store: MessageRefStore) =>
				store.removeTag("message-0", "absent"),
		},
	])("does not refresh recency when $name", ({ mutate }) => {
		const store = new MessageRefStore();
		store.saveMessage(message(0, { tags: ["keep"] }));
		fillMessagesAfter(store, 1);

		expect(mutate(store)?.tags).toEqual(["keep"]);
		store.saveMessage(message(MESSAGE_CAPACITY));

		expect(store.getMessage("message-0")).toBeNull();
		expect(store.getMessage("message-1")).not.toBeNull();
	});

	it("keeps an overwritten draft and evicts the oldest untouched draft", () => {
		const store = new MessageRefStore();
		fillDrafts(store);

		store.saveDraft(draft(0, { body: "fresh draft body" }));
		store.saveDraft(draft(DRAFT_CAPACITY));

		expect(store.getDraft("draft-0")?.body).toBe("fresh draft body");
		expect(store.getDraft("draft-1")).toBeNull();
		expect(store.getDraft(`draft-${DRAFT_CAPACITY}`)).not.toBeNull();
	});

	it("keeps a sent draft and its provider result across overflow", () => {
		const store = new MessageRefStore();
		fillDrafts(store);

		expect(store.markDraftSent("draft-0", "provider-message-0")).toMatchObject({
			sent: true,
			sentExternalId: "provider-message-0",
		});
		store.saveDraft(draft(DRAFT_CAPACITY));

		expect(store.getDraft("draft-0")).toMatchObject({
			sent: true,
			sentExternalId: "provider-message-0",
		});
		expect(store.getDraft("draft-1")).toBeNull();
	});

	it("keeps a scheduled draft and its durable commit across overflow", () => {
		const store = new MessageRefStore();
		fillDrafts(store);
		const scheduleCommit = {
			kind: "durable" as const,
			id: "task-0",
			committedAt: "2026-08-12T21:00:00.000Z",
			idempotencyKey: "schedule-draft-0",
			replayed: false,
		};

		expect(
			store.markDraftScheduled(
				"draft-0",
				1_786_569_000_000,
				"schedule-0",
				scheduleCommit,
			),
		).toMatchObject({
			scheduledForMs: 1_786_569_000_000,
			scheduledId: "schedule-0",
			scheduleCommit,
		});
		store.saveDraft(draft(DRAFT_CAPACITY));

		expect(store.getDraft("draft-0")).toMatchObject({
			scheduledForMs: 1_786_569_000_000,
			scheduledId: "schedule-0",
			scheduleCommit,
		});
		expect(store.getDraft("draft-1")).toBeNull();
	});
});
