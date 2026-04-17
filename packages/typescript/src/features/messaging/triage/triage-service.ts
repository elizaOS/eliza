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
import {
	MessageRefStore,
	getDefaultMessageRefStore,
} from "./message-ref-store.ts";
import { rankScored, scoreMessages } from "./triage-engine.ts";
import {
	type DraftRecord,
	type DraftRequest,
	type MessageAdapter,
	type MessageRef,
	type MessageSource,
	NotYetImplementedError,
} from "./types.ts";
import { DiscordMessageAdapter } from "./adapters/discord-adapter.ts";
import { GmailMessageAdapter } from "./adapters/gmail-adapter.ts";
import { IMessageMessageAdapter } from "./adapters/imessage-adapter.ts";
import { SignalMessageAdapter } from "./adapters/signal-adapter.ts";
import { TelegramMessageAdapter } from "./adapters/telegram-adapter.ts";
import { TwitterMessageAdapter } from "./adapters/twitter-adapter.ts";
import { WhatsappMessageAdapter } from "./adapters/whatsapp-adapter.ts";

export interface TriageOptions {
	sources?: MessageSource[];
	sinceMs?: number;
	limit?: number;
	nowMs?: number;
}

export class TriageService {
	private adapters = new Map<MessageSource, MessageAdapter>();

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

	getStore(): MessageRefStore {
		return this.store;
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
			});
			all.push(...batch);
		}

		const scored = await scoreMessages(runtime, all, { nowMs: opts.nowMs });
		this.store.saveMessages(scored);
		return rankScored(scored);
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
			throw new Error(
				`No adapter registered for source "${original.source}"`,
			);
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
		},
	): Promise<DraftRecord> {
		const adapter = this.adapters.get(params.source);
		if (!adapter) {
			throw new Error(
				`No adapter registered for source "${params.source}"`,
			);
		}
		const { draftId, preview } = await adapter.createDraft(runtime, {
			source: params.source,
			threadId: params.threadId,
			to: params.to,
			subject: params.subject,
			body: params.body,
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
