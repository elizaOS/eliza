/**
 * Base class for MessageAdapters. Concrete adapters own:
 *  - availability detection (is the underlying plugin registered?)
 *  - list/fetch mapping from platform payload to MessageRef
 *  - draft lifecycle (createDraft + sendDraft)
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
	type MessageAdapter,
	type MessageRef,
	type MessageSource,
	NotYetImplementedError,
} from "../types.ts";

export abstract class BaseMessageAdapter implements MessageAdapter {
	abstract readonly source: MessageSource;

	private unavailableLogged = false;

	abstract isAvailable(runtime: IAgentRuntime): boolean;

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
}
