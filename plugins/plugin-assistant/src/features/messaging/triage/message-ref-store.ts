/**
 * Turn-local cache for MessageRefs and active draft previews.
 *
 * Connector stores remain authoritative for inbox data. Deferred sends copy
 * their complete draft snapshot into the canonical ScheduledTask row before
 * reporting success, so this cache is never relied on across a restart.
 */

import type { UUID } from "@elizaos/core";
import type { DraftRecord, MessageRef, MessageSource } from "./types.ts";

function setMostRecent<K, V>(map: Map<K, V>, key: K, value: V): void {
  // Map.set preserves an existing key's insertion slot, so delete it first.
  map.delete(key);
  map.set(key, value);
}

export class MessageRefStore {
  private messages = new Map<string, Map<string, MessageRef>>();
  private drafts = new Map<string, Map<string, DraftRecord>>();

  private scope(agentId: UUID): string {
    return String(agentId);
  }

  private messageScope(agentId: UUID): Map<string, MessageRef> {
    const scope = this.scope(agentId);
    let messages = this.messages.get(scope);
    if (!messages) {
      messages = new Map<string, MessageRef>();
      this.messages.set(scope, messages);
    }
    return messages;
  }

  private draftScope(agentId: UUID): Map<string, DraftRecord> {
    const scope = this.scope(agentId);
    let drafts = this.drafts.get(scope);
    if (!drafts) {
      drafts = new Map<string, DraftRecord>();
      this.drafts.set(scope, drafts);
    }
    return drafts;
  }

  saveMessage(ref: MessageRef, agentId: UUID): void {
    setMostRecent(this.messageScope(agentId), ref.id, ref);
  }

  saveMessages(refs: readonly MessageRef[], agentId: UUID): void {
    const messages = this.messageScope(agentId);
    for (const r of refs) setMostRecent(messages, r.id, r);
  }

  /** Forget only transient source metadata; drafts and provider mail are untouched. */
  forgetSource(source: MessageSource): void {
    for (const messages of this.messages.values())
      for (const [id, ref] of messages)
        if (ref.source === source) messages.delete(id);
  }

  getMessage(id: string, agentId: UUID): MessageRef | null {
    return this.messages.get(this.scope(agentId))?.get(id) ?? null;
  }

  findByExternalId(
    source: MessageSource,
    externalId: string,
    agentId: UUID,
  ): MessageRef | null {
    const messages = [
      ...(this.messages.get(this.scope(agentId))?.values() ?? []),
    ];
    for (const m of messages) {
      if (m.source === source && m.externalId === externalId) return m;
    }
    return null;
  }

  addTag(messageId: string, tag: string, agentId: UUID): MessageRef | null {
    const messages = this.messageScope(agentId);
    const existing = messages.get(messageId);
    if (!existing) return null;
    if (existing.tags?.includes(tag)) return existing;
    const tags = existing.tags ? [...existing.tags] : [];
    tags.push(tag);
    const next: MessageRef = { ...existing, tags };
    setMostRecent(messages, messageId, next);
    return next;
  }

  removeTag(messageId: string, tag: string, agentId: UUID): MessageRef | null {
    const messages = this.messageScope(agentId);
    const existing = messages.get(messageId);
    if (!existing) return null;
    if (!existing.tags || existing.tags.length === 0) return existing;
    const tags = existing.tags.filter((t) => t !== tag);
    if (tags.length === existing.tags.length) return existing;
    const next: MessageRef = { ...existing, tags };
    setMostRecent(messages, messageId, next);
    return next;
  }

  saveDraft(record: DraftRecord, agentId: UUID): void {
    const owned = { ...record, agentId };
    setMostRecent(this.draftScope(agentId), owned.draftId, owned);
  }

  getDraft(draftId: string, agentId: UUID): DraftRecord | null {
    return this.drafts.get(this.scope(agentId))?.get(draftId) ?? null;
  }

  markDraftSent(
    draftId: string,
    externalId: string,
    agentId: UUID,
  ): DraftRecord | null {
    const drafts = this.draftScope(agentId);
    const existing = drafts.get(draftId);
    if (!existing) return null;
    const next: DraftRecord = {
      ...existing,
      sent: true,
      sentExternalId: externalId,
    };
    setMostRecent(drafts, draftId, next);
    return next;
  }

  markDraftScheduled(
    draftId: string,
    sendAtMs: number,
    scheduledId: string,
    scheduleCommit: NonNullable<DraftRecord["scheduleCommit"]>,
    agentId: UUID,
  ): DraftRecord | null {
    const drafts = this.draftScope(agentId);
    const existing = drafts.get(draftId);
    if (!existing) return null;
    const next: DraftRecord = {
      ...existing,
      scheduledForMs: sendAtMs,
      scheduledId,
      scheduleCommit,
    };
    setMostRecent(drafts, draftId, next);
    return next;
  }

  listMessages(agentId: UUID): MessageRef[] {
    return Array.from(this.messages.get(this.scope(agentId))?.values() ?? []);
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
