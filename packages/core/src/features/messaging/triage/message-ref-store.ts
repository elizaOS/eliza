/**
 * Bounded turn-local cache for MessageRefs and active draft previews.
 *
 * Connector stores remain authoritative for inbox data. Deferred sends copy
 * their complete draft snapshot into the canonical ScheduledTask row before
 * reporting success, so this cache is never relied on across a restart.
 */

import type { DraftRecord, MessageRef, MessageSource } from "./types.ts";

// Process-local stores grow one entry per message/draft ever seen by triage.
// Without a bound, a long-running agent that triages many messages leaks memory.
// Cap by last-write order (Map insertion order refreshed on writes) — oldest
// refs drop once over the cap while recently-saved active entries stay resident.
const MAX_MESSAGES = 5000;
const MAX_DRAFTS = 2000;

function setMostRecent<K, V>(map: Map<K, V>, key: K, value: V): void {
	// Map.set preserves an existing key's insertion slot, so delete it first.
	map.delete(key);
	map.set(key, value);
}

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
		setMostRecent(this.messages, ref.id, ref);
		capMap(this.messages, MAX_MESSAGES);
	}

	saveMessages(refs: readonly MessageRef[]): void {
		for (const r of refs) setMostRecent(this.messages, r.id, r);
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
		if (existing.tags?.includes(tag)) return existing;
		const tags = existing.tags ? [...existing.tags] : [];
		tags.push(tag);
		const next: MessageRef = { ...existing, tags };
		setMostRecent(this.messages, messageId, next);
		return next;
	}

	removeTag(messageId: string, tag: string): MessageRef | null {
		const existing = this.messages.get(messageId);
		if (!existing) return null;
		if (!existing.tags || existing.tags.length === 0) return existing;
		const tags = existing.tags.filter((t) => t !== tag);
		if (tags.length === existing.tags.length) return existing;
		const next: MessageRef = { ...existing, tags };
		setMostRecent(this.messages, messageId, next);
		return next;
	}

	saveDraft(record: DraftRecord): void {
		setMostRecent(this.drafts, record.draftId, record);
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
		setMostRecent(this.drafts, draftId, next);
		return next;
	}

	markDraftScheduled(
		draftId: string,
		sendAtMs: number,
		scheduledId: string,
		scheduleCommit: NonNullable<DraftRecord["scheduleCommit"]>,
	): DraftRecord | null {
		const existing = this.drafts.get(draftId);
		if (!existing) return null;
		const next: DraftRecord = {
			...existing,
			scheduledForMs: sendAtMs,
			scheduledId,
			scheduleCommit,
		};
		setMostRecent(this.drafts, draftId, next);
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
