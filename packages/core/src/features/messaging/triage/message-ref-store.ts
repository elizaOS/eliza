/**
 * In-memory store for MessageRefs and drafts, keyed by deterministic IDs.
 *
 * This is intentionally process-local: adapters fetch from their underlying
 * plugins, but the triage actions need a stable handle to refer to messages
 * and drafts across subsequent agent turns. Long-term persistence is owned
 * by each adapter's underlying plugin.
 */

import type { DraftRecord, MessageRef, MessageSource } from "./types.ts";

export class MessageRefStore {
	private messages = new Map<string, MessageRef>();
	private drafts = new Map<string, DraftRecord>();

	saveMessage(ref: MessageRef): void {
		this.messages.set(ref.id, ref);
	}

	saveMessages(refs: readonly MessageRef[]): void {
		for (const r of refs) this.messages.set(r.id, r);
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

	saveDraft(record: DraftRecord): void {
		this.drafts.set(record.draftId, record);
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
