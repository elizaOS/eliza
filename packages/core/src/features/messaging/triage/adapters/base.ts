/**
 * Base class for MessageAdapters. Concrete adapters own:
 *  - availability detection (is the underlying plugin registered?)
 *  - capability declaration (what verbs the connector actually supports)
 *  - list/fetch mapping from platform payload to MessageRef
 *  - draft lifecycle (createDraft + sendDraft) and optional schedule/manage/search
 *
 * Until the underlying plugins exist (tracked under T5X in the plan), each
 * adapter reports isAvailable=false and returns an empty list from
 * listMessages. sendDraft throws NotYetImplementedError because a silent
 * no-op would violate the "no stub" rule.
 */

import { logger } from "../../../../logger.ts";
import type { IAgentRuntime } from "../../../../types/index.ts";
import {
	type DraftRequest,
	type ListOptions,
	type ManageOperation,
	type ManageResult,
	type MessageAdapter,
	type MessageAdapterCapabilities,
	type MessageRef,
	type MessageSource,
	NotYetImplementedError,
	type SearchMessagesFilters,
} from "../types.ts";

export abstract class BaseMessageAdapter implements MessageAdapter {
	abstract readonly source: MessageSource;

	private unavailableLogged = false;

	abstract isAvailable(runtime: IAgentRuntime): boolean;

	/**
	 * Default capability profile: a stub adapter advertises nothing. Concrete
	 * adapters override to declare what their underlying connector supports.
	 */
	capabilities(): MessageAdapterCapabilities {
		return {
			list: false,
			search: false,
			manage: {},
			send: {},
			worlds: "single",
			channels: "none",
		};
	}

	protected logUnavailableOnce(): void {
		if (this.unavailableLogged) return;
		this.unavailableLogged = true;
		logger.info(
			`[MessagingTriage:${this.source}] adapter unavailable (underlying plugin not registered); returning empty list`,
		);
	}

	async listMessages(
		runtime: IAgentRuntime,
		opts: ListOptions,
	): Promise<MessageRef[]> {
		if (!this.isAvailable(runtime)) {
			this.logUnavailableOnce();
			return [];
		}
		return this.listMessagesImpl(runtime, opts);
	}

	async getMessage(
		runtime: IAgentRuntime,
		id: string,
	): Promise<MessageRef | null> {
		if (!this.isAvailable(runtime)) {
			this.logUnavailableOnce();
			return null;
		}
		return this.getMessageImpl(runtime, id);
	}

	async searchMessages(
		runtime: IAgentRuntime,
		filters: SearchMessagesFilters,
	): Promise<MessageRef[]> {
		if (!this.isAvailable(runtime)) {
			this.logUnavailableOnce();
			return [];
		}
		const cap = this.capabilities();
		if (cap.search) return this.searchMessagesImpl(runtime, filters);
		// Degrade to a list-then-filter pass when the connector lacks native search.
		const listed = await this.listMessages(runtime, {
			sinceMs: filters.sinceMs,
			limit: filters.limit,
			worldIds: filters.worldIds,
			channelIds: filters.channelIds,
		});
		return filterInMemory(listed, filters);
	}

	async manageMessage(
		runtime: IAgentRuntime,
		messageId: string,
		op: ManageOperation,
	): Promise<ManageResult> {
		if (!this.isAvailable(runtime)) {
			this.logUnavailableOnce();
			return { ok: false, reason: `${this.source} adapter unavailable` };
		}
		return this.manageMessageImpl(runtime, messageId, op);
	}

	async createDraft(
		runtime: IAgentRuntime,
		draft: DraftRequest,
	): Promise<{ draftId: string; preview: string }> {
		if (!this.isAvailable(runtime)) {
			throw new NotYetImplementedError(
				`waiting on T5X: ${this.source} adapter (createDraft)`,
			);
		}
		return this.createDraftImpl(runtime, draft);
	}

	async sendDraft(
		runtime: IAgentRuntime,
		draftId: string,
	): Promise<{ externalId: string }> {
		if (!this.isAvailable(runtime)) {
			throw new NotYetImplementedError(
				`waiting on T5X: ${this.source} adapter (sendDraft)`,
			);
		}
		return this.sendDraftImpl(runtime, draftId);
	}

	async scheduleSend(
		runtime: IAgentRuntime,
		draftId: string,
		sendAtMs: number,
	): Promise<{ scheduledId: string }> {
		if (!this.isAvailable(runtime)) {
			throw new NotYetImplementedError(
				`waiting on T5X: ${this.source} adapter (scheduleSend)`,
			);
		}
		return this.scheduleSendImpl(runtime, draftId, sendAtMs);
	}

	// Hooks implemented only when the adapter is actually available.
	protected listMessagesImpl(
		_runtime: IAgentRuntime,
		_opts: ListOptions,
	): Promise<MessageRef[]> {
		throw new NotYetImplementedError(
			`waiting on T5X: ${this.source} adapter (listMessagesImpl)`,
		);
	}

	protected getMessageImpl(
		_runtime: IAgentRuntime,
		_id: string,
	): Promise<MessageRef | null> {
		throw new NotYetImplementedError(
			`waiting on T5X: ${this.source} adapter (getMessageImpl)`,
		);
	}

	protected searchMessagesImpl(
		_runtime: IAgentRuntime,
		_filters: SearchMessagesFilters,
	): Promise<MessageRef[]> {
		throw new NotYetImplementedError(
			`waiting on T5X: ${this.source} adapter (searchMessagesImpl)`,
		);
	}

	protected manageMessageImpl(
		_runtime: IAgentRuntime,
		_messageId: string,
		_op: ManageOperation,
	): Promise<ManageResult> {
		return Promise.resolve({
			ok: false,
			reason: `${this.source} adapter does not support manage operations`,
		});
	}

	protected createDraftImpl(
		_runtime: IAgentRuntime,
		_draft: DraftRequest,
	): Promise<{ draftId: string; preview: string }> {
		throw new NotYetImplementedError(
			`waiting on T5X: ${this.source} adapter (createDraftImpl)`,
		);
	}

	protected sendDraftImpl(
		_runtime: IAgentRuntime,
		_draftId: string,
	): Promise<{ externalId: string }> {
		throw new NotYetImplementedError(
			`waiting on T5X: ${this.source} adapter (sendDraftImpl)`,
		);
	}

	protected scheduleSendImpl(
		_runtime: IAgentRuntime,
		_draftId: string,
		_sendAtMs: number,
	): Promise<{ scheduledId: string }> {
		throw new NotYetImplementedError(
			`waiting on T5X: ${this.source} adapter (scheduleSendImpl)`,
		);
	}
}

/**
 * Pure in-memory filter shared by adapters that lack native search and by
 * the cross-connector MESSAGE action when it merges results.
 */
export function filterInMemory(
	messages: MessageRef[],
	filters: SearchMessagesFilters,
): MessageRef[] {
	const contentLower = filters.content?.toLowerCase().trim();
	const senderId = filters.sender?.identifier?.toLowerCase();
	const senderName = filters.sender?.displayName?.toLowerCase();
	const worlds = filters.worldIds && new Set(filters.worldIds);
	const channels = filters.channelIds && new Set(filters.channelIds);
	const wantedTags = filters.tags ?? [];
	const sinceMs = filters.sinceMs;
	const untilMs = filters.untilMs;

	const out: MessageRef[] = [];
	for (const m of messages) {
		if (filters.sources && !filters.sources.includes(m.source)) continue;
		if (worlds && (!m.worldId || !worlds.has(m.worldId))) continue;
		if (channels && (!m.channelId || !channels.has(m.channelId))) continue;
		if (sinceMs !== undefined && m.receivedAtMs < sinceMs) continue;
		if (untilMs !== undefined && m.receivedAtMs > untilMs) continue;
		if (senderId && m.from.identifier.toLowerCase() !== senderId) continue;
		if (senderName) {
			const name = m.from.displayName?.toLowerCase();
			if (!name?.includes(senderName)) continue;
		}
		if (wantedTags.length > 0) {
			const tags = m.tags ?? [];
			let allFound = true;
			for (const t of wantedTags) {
				if (!tags.includes(t)) {
					allFound = false;
					break;
				}
			}
			if (!allFound) continue;
		}
		if (contentLower) {
			const haystack =
				`${m.subject ?? ""} ${m.snippet} ${m.body ?? ""}`.toLowerCase();
			if (!haystack.includes(contentLower)) continue;
		}
		out.push(m);
	}
	return out;
}
