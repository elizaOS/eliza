/**
 * TriageService — coordinates adapters, scoring, and the draft store.
 *
 * Usage:
 *   const service = new TriageService();
 *   service.register(new GmailMessageAdapter());
 *   await service.triage(runtime, { sources: ["gmail"] });
 */

import { logger } from "../../../logger.ts";
import type { IAgentRuntime } from "../../../types/index.ts";
import { filterInMemory } from "./adapters/base.ts";
import { DiscordMessageAdapter } from "./adapters/discord-adapter.ts";
import { GmailMessageAdapter } from "./adapters/gmail-adapter.ts";
import { IMessageMessageAdapter } from "./adapters/imessage-adapter.ts";
import { SignalMessageAdapter } from "./adapters/signal-adapter.ts";
import { TelegramMessageAdapter } from "./adapters/telegram-adapter.ts";
import { TwitterMessageAdapter } from "./adapters/twitter-adapter.ts";
import { WhatsappMessageAdapter } from "./adapters/whatsapp-adapter.ts";
import {
	getDefaultMessageRefStore,
	type MessageRefStore,
} from "./message-ref-store.ts";
import { rankScored, scoreMessages } from "./triage-engine.ts";
import {
	type DraftRecord,
	type DraftRequest,
	type ManageOperation,
	type ManageResult,
	type MessageAdapter,
	type MessageRef,
	type MessageSource,
	NotYetImplementedError,
	type SearchMessagesFilters,
} from "./types.ts";

export interface TriageOptions {
	sources?: MessageSource[];
	worldIds?: string[];
	channelIds?: string[];
	sinceMs?: number;
	limit?: number;
	nowMs?: number;
}

export class TriageService {
	private adapters = new Map<MessageSource, MessageAdapter>();
	// Keyed by `${source}:${messageId}` → owning adapter, populated as messages
	// flow through triage(). Used to route MESSAGE without a per-call hint.
	private adapterByMessageId = new Map<string, MessageAdapter>();

	constructor(
		private readonly store: MessageRefStore = getDefaultMessageRefStore(),
	) {}

	register(adapter: MessageAdapter): void {
		this.adapters.set(adapter.source, adapter);
	}

	getAdapter(source: MessageSource): MessageAdapter | undefined {
		return this.adapters.get(source);
	}

	listRegisteredSources(): MessageSource[] {
		return Array.from(this.adapters.keys());
	}

	listAdapters(): MessageAdapter[] {
		return Array.from(this.adapters.values());
	}

	getStore(): MessageRefStore {
		return this.store;
	}

	private trackAdapterForMessage(
		source: MessageSource,
		messageId: string,
	): void {
		const adapter = this.adapters.get(source);
		if (!adapter) return;
		this.adapterByMessageId.set(`${source}:${messageId}`, adapter);
	}

	getAdapterForMessage(messageId: string): MessageAdapter | undefined {
		// Fast path: explicit source:id key.
		for (const [key, adapter] of this.adapterByMessageId) {
			if (key.endsWith(`:${messageId}`)) return adapter;
		}
		// Fallback: look up via the store.
		const ref = this.store.getMessage(messageId);
		if (!ref) return undefined;
		return this.adapters.get(ref.source);
	}

	/**
	 * Fetch messages from every requested (and registered) source, score
	 * them, persist them in the store, and return the ranked list.
	 */
	async triage(
		runtime: IAgentRuntime,
		opts: TriageOptions = {},
	): Promise<MessageRef[]> {
		const requested = opts.sources ?? this.listRegisteredSources();
		const all: MessageRef[] = [];
		for (const source of requested) {
			const adapter = this.adapters.get(source);
			if (!adapter) {
				logger.info(
					`[TriageService] No adapter registered for source "${source}"; skipping`,
				);
				continue;
			}
			const batch = await adapter.listMessages(runtime, {
				sinceMs: opts.sinceMs,
				limit: opts.limit,
				worldIds: opts.worldIds,
				channelIds: opts.channelIds,
			});
			for (const ref of batch) {
				this.trackAdapterForMessage(ref.source, ref.id);
			}
			all.push(...batch);
		}

		const scored = await scoreMessages(runtime, all, { nowMs: opts.nowMs });
		this.store.saveMessages(scored);
		return rankScored(scored);
	}

	/**
	 * Cross-connector search. Each adapter contributes either via its native
	 * searchMessages (capabilities.search === true) or by falling back to
	 * listMessages + in-memory filter.
	 */
	async search(
		runtime: IAgentRuntime,
		filters: SearchMessagesFilters,
	): Promise<MessageRef[]> {
		const requested = filters.sources ?? this.listRegisteredSources();
		const merged: MessageRef[] = [];
		for (const source of requested) {
			const adapter = this.adapters.get(source);
			if (!adapter) continue;
			if (!adapter.isAvailable(runtime)) continue;
			const hits =
				adapter.searchMessages != null
					? await adapter.searchMessages(runtime, filters)
					: filterInMemory(
							await adapter.listMessages(runtime, {
								sinceMs: filters.sinceMs,
								limit: filters.limit,
								worldIds: filters.worldIds,
								channelIds: filters.channelIds,
							}),
							filters,
						);
			for (const ref of hits) {
				this.trackAdapterForMessage(ref.source, ref.id);
			}
			merged.push(...hits);
		}
		this.store.saveMessages(merged);
		merged.sort((a, b) => b.receivedAtMs - a.receivedAtMs);
		const limit = filters.limit ?? merged.length;
		return merged.slice(0, limit);
	}

	async manage(
		runtime: IAgentRuntime,
		messageId: string,
		op: ManageOperation,
		hint?: { source?: MessageSource },
	): Promise<ManageResult> {
		const adapter = hint?.source
			? this.adapters.get(hint.source)
			: this.getAdapterForMessage(messageId);
		if (!adapter) {
			return {
				ok: false,
				reason: `no adapter resolved for message ${messageId}`,
			};
		}
		// Local tag mutations don't need adapter support — keep them in the store.
		if (op.kind === "tag_add") {
			const updated = this.store.addTag(messageId, op.tag);
			if (!updated) {
				return { ok: false, reason: `message ${messageId} not in store` };
			}
		} else if (op.kind === "tag_remove") {
			this.store.removeTag(messageId, op.tag);
		}
		if (adapter.manageMessage == null) {
			// adapter doesn't override manage — for tag ops we already mutated the
			// local store, so report success with a note.
			if (op.kind === "tag_add" || op.kind === "tag_remove") {
				return { ok: true };
			}
			return {
				ok: false,
				reason: `${adapter.source} adapter does not implement manageMessage`,
			};
		}
		return adapter.manageMessage(runtime, messageId, op);
	}

	async draftReply(
		runtime: IAgentRuntime,
		inReplyToId: string,
		body: string,
	): Promise<DraftRecord> {
		const original = this.store.getMessage(inReplyToId);
		if (!original) {
			throw new Error(`No message found for id ${inReplyToId}`);
		}
		const adapter = this.adapters.get(original.source);
		if (!adapter) {
			throw new Error(`No adapter registered for source "${original.source}"`);
		}
		const draftRequest: DraftRequest = {
			source: original.source,
			inReplyToId,
			threadId: original.threadId,
			to: [original.from],
			subject: original.subject
				? original.subject.toLowerCase().startsWith("re:")
					? original.subject
					: `Re: ${original.subject}`
				: undefined,
			body,
			worldId: original.worldId,
			channelId: original.channelId,
		};
		const { draftId, preview } = await adapter.createDraft(
			runtime,
			draftRequest,
		);
		const record: DraftRecord = {
			draftId,
			source: original.source,
			inReplyToId,
			threadId: original.threadId,
			to: draftRequest.to,
			subject: draftRequest.subject,
			body,
			preview,
			createdAtMs: Date.now(),
			sent: false,
			worldId: draftRequest.worldId,
			channelId: draftRequest.channelId,
		};
		this.store.saveDraft(record);
		return record;
	}

	async draftFollowup(
		runtime: IAgentRuntime,
		params: {
			source: MessageSource;
			to: Array<{ identifier: string; displayName?: string }>;
			subject?: string;
			body: string;
			threadId?: string;
			worldId?: string;
			channelId?: string;
		},
	): Promise<DraftRecord> {
		const adapter = this.adapters.get(params.source);
		if (!adapter) {
			throw new Error(`No adapter registered for source "${params.source}"`);
		}
		const { draftId, preview } = await adapter.createDraft(runtime, {
			source: params.source,
			threadId: params.threadId,
			to: params.to,
			subject: params.subject,
			body: params.body,
			worldId: params.worldId,
			channelId: params.channelId,
		});
		const record: DraftRecord = {
			draftId,
			source: params.source,
			threadId: params.threadId,
			to: params.to,
			subject: params.subject,
			body: params.body,
			preview,
			createdAtMs: Date.now(),
			sent: false,
			worldId: params.worldId,
			channelId: params.channelId,
		};
		this.store.saveDraft(record);
		return record;
	}

	async sendDraft(
		runtime: IAgentRuntime,
		draftId: string,
	): Promise<DraftRecord> {
		const record = this.store.getDraft(draftId);
		if (!record) throw new Error(`No draft found for id ${draftId}`);
		if (record.sent) return record;
		const adapter = this.adapters.get(record.source);
		if (!adapter) {
			throw new NotYetImplementedError(
				`waiting on T5X: ${record.source} adapter (sendDraft)`,
			);
		}
		const { externalId } = await adapter.sendDraft(runtime, draftId);
		const updated = this.store.markDraftSent(draftId, externalId);
		return updated ?? record;
	}

	async scheduleDraftSend(
		runtime: IAgentRuntime,
		draftId: string,
		sendAtMs: number,
	): Promise<DraftRecord> {
		const record = this.store.getDraft(draftId);
		if (!record) throw new Error(`No draft found for id ${draftId}`);
		if (record.sent) return record;
		const adapter = this.adapters.get(record.source);
		if (!adapter) {
			throw new NotYetImplementedError(
				`no adapter for ${record.source} (scheduleSend)`,
			);
		}

		// Prefer adapter-native scheduling when supported. Otherwise enqueue a
		// process-local timer — this is non-durable and fine for a Wave 1 hook.
		if (
			adapter.capabilities().send.schedule === true &&
			adapter.scheduleSend != null
		) {
			const { scheduledId } = await adapter.scheduleSend(
				runtime,
				draftId,
				sendAtMs,
			);
			const updated = this.store.markDraftScheduled(
				draftId,
				sendAtMs,
				scheduledId,
			);
			return updated ?? record;
		}

		const scheduledId = enqueueLocalDeferredSend(
			this,
			runtime,
			draftId,
			sendAtMs,
		);
		const updated = this.store.markDraftScheduled(
			draftId,
			sendAtMs,
			scheduledId,
		);
		return updated ?? record;
	}
}

// Process-local deferred-send queue. Non-durable; survives only as long as the
// process. Adapter-native scheduling should be preferred when available.
const localTimers = new Map<string, NodeJS.Timeout>();

function enqueueLocalDeferredSend(
	service: TriageService,
	runtime: IAgentRuntime,
	draftId: string,
	sendAtMs: number,
): string {
	const scheduledId = `local:${draftId}:${sendAtMs}`;
	const existing = localTimers.get(scheduledId);
	if (existing) return scheduledId;
	const delayMs = Math.max(0, sendAtMs - Date.now());
	const timer = setTimeout(() => {
		localTimers.delete(scheduledId);
		service.sendDraft(runtime, draftId).catch((err) => {
			logger.error(
				`[TriageService] deferred sendDraft failed draftId=${draftId}: ${err instanceof Error ? err.message : String(err)}`,
			);
		});
	}, delayMs);
	// Don't keep the event loop alive solely for a deferred send.
	if (typeof timer.unref === "function") timer.unref();
	localTimers.set(scheduledId, timer);
	return scheduledId;
}

/**
 * Convenience factory that registers all built-in adapters. Availability is
 * evaluated at request time so new plugins become usable without rewiring.
 */
export function createDefaultTriageService(
	store?: MessageRefStore,
): TriageService {
	const service = new TriageService(store);
	service.register(new GmailMessageAdapter());
	service.register(new DiscordMessageAdapter());
	service.register(new TelegramMessageAdapter());
	service.register(new TwitterMessageAdapter());
	service.register(new IMessageMessageAdapter());
	service.register(new SignalMessageAdapter());
	service.register(new WhatsappMessageAdapter());
	return service;
}

let singleton: TriageService | null = null;
export function getDefaultTriageService(): TriageService {
	if (!singleton) singleton = createDefaultTriageService();
	return singleton;
}

export function __resetDefaultTriageServiceForTests(): void {
	singleton = null;
}
