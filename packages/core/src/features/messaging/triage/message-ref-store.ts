/**
 * In-memory store for MessageRefs and drafts, keyed by deterministic IDs.
 *
 * This is intentionally process-local: adapters fetch from their underlying
 * plugins, but the triage actions need a stable handle to refer to messages
 * and drafts across subsequent agent turns. Long-term persistence is owned
 * by each adapter's underlying plugin.
 */

import type { DraftRecord, MessageRef, MessageSource } from "./types.ts";

// Process-local stores grow one entry per message/draft ever seen by triage.
// Without a bound, a long-running agent that triages many messages leaks memory.
// Cap with FIFO eviction (Map insertion order) — oldest refs drop once over the
// cap; active turns reference recently-saved messages, which stay resident.
const MAX_MESSAGES = 5000;
const MAX_DRAFTS = 2000;

function capMap<K, V>(map: Map<K, V>, max: number): void {
	while (map.size > max) {
		const oldest = map.keys().next().value;
		if (oldest === undefined) break;
		map.delete(oldest);
	}
}

export class MessageRefStore {
	private messages = new Map<string, MessageRef>();
	private drafts = new Map<string, DraftRecord>();

	saveMessage(ref: MessageRef): void {
		this.messages.set(ref.id, ref);
		capMap(this.messages, MAX_MESSAGES);
	}

	saveMessages(refs: readonly MessageRef[]): void {
		for (const r of refs) this.messages.set(r.id, r);
		capMap(this.messages, MAX_MESSAGES);
	}

	getMessage(id: string): MessageRef | null {
		return this.messages.get(id) ?? null;
	}

	findByExternalId(
		source: MessageSource,
		externalId: string,
	): MessageRef | null {
		for (const m of this.messages.values()) {
			if (m.source === source && m.externalId === externalId) return m;
		}
		return null;
	}

	addTag(messageId: string, tag: string): MessageRef | null {
		const existing = this.messages.get(messageId);
		if (!existing) return null;
		const tags = existing.tags ? [...existing.tags] : [];
		if (!tags.includes(tag)) tags.push(tag);
		const next: MessageRef = { ...existing, tags };
		this.messages.set(messageId, next);
		return next;
	}

	removeTag(messageId: string, tag: string): MessageRef | null {
		const existing = this.messages.get(messageId);
		if (!existing) return null;
		if (!existing.tags || existing.tags.length === 0) return existing;
		const tags = existing.tags.filter((t) => t !== tag);
		const next: MessageRef = { ...existing, tags };
		this.messages.set(messageId, next);
		return next;
	}

	saveDraft(record: DraftRecord): void {
		this.drafts.set(record.draftId, record);
		capMap(this.drafts, MAX_DRAFTS);
	}

	getDraft(draftId: string): DraftRecord | null {
		return this.drafts.get(draftId) ?? null;
	}

	markDraftSent(draftId: string, externalId: string): DraftRecord | null {
		const existing = this.drafts.get(draftId);
		if (!existing) return null;
		const next: DraftRecord = {
			...existing,
			sent: true,
			sentExternalId: externalId,
		};
		this.drafts.set(draftId, next);
		return next;
	}

	markDraftScheduled(
		draftId: string,
		sendAtMs: number,
		scheduledId: string,
	): DraftRecord | null {
		const existing = this.drafts.get(draftId);
		if (!existing) return null;
		const next: DraftRecord = {
			...existing,
			scheduledForMs: sendAtMs,
			scheduledId,
		};
		this.drafts.set(draftId, next);
		return next;
	}

	listMessages(): MessageRef[] {
		return Array.from(this.messages.values());
	}

	clear(): void {
		this.messages.clear();
		this.drafts.clear();
	}
}

/** Lazily-constructed singleton used by actions and the service. */
let singleton: MessageRefStore | null = null;
export function getDefaultMessageRefStore(): MessageRefStore {
	if (!singleton) singleton = new MessageRefStore();
	return singleton;
}

export function __resetDefaultMessageRefStoreForTests(): void {
	singleton = null;
}
