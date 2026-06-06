/**
 * PendingPromptsStore — the queue of prompts the agent has scheduled to ask
 * the owner but has not yet delivered or resolved. Used by the LifeOps
 * approval / follow-up machinery; centralized so any feature can enqueue or
 * cancel.
 *
 * STUB — placeholder for the future core-resident pending-prompts store.
 *
 * TODO(migrate: plugins/plugin-personal-assistant/src/lifeops/pending-prompts ->
 *               packages/core/src/owner-state/pending-prompts.ts)
 */

export interface PendingPrompt {
	readonly id: string;
	/** The owner-facing question, rendered or template id. */
	readonly question: string;
	/** Free-form caller tag — which feature enqueued this prompt. */
	readonly origin: string;
	readonly createdAt: string;
	/** Optional deadline after which the prompt is considered stale. */
	readonly expiresAt?: string;
	/** Optional structured payload the consumer attached. */
	readonly payload?: unknown;
}

export interface PendingPromptsStore {
	enqueue(prompt: Omit<PendingPrompt, "createdAt">): Promise<void>;
	dequeue(id: string): Promise<PendingPrompt | null>;
	list(): Promise<readonly PendingPrompt[]>;
	clear(origin?: string): Promise<void>;
}

export class StubPendingPromptsStore implements PendingPromptsStore {
	async enqueue(_prompt: Omit<PendingPrompt, "createdAt">): Promise<void> {
		throw new Error(
			"[StubPendingPromptsStore] not implemented — see packages/core/src/owner-state/README.md",
		);
	}

	async dequeue(_id: string): Promise<PendingPrompt | null> {
		throw new Error(
			"[StubPendingPromptsStore] not implemented — see packages/core/src/owner-state/README.md",
		);
	}

	async list(): Promise<readonly PendingPrompt[]> {
		throw new Error(
			"[StubPendingPromptsStore] not implemented — see packages/core/src/owner-state/README.md",
		);
	}

	async clear(_origin?: string): Promise<void> {
		throw new Error(
			"[StubPendingPromptsStore] not implemented — see packages/core/src/owner-state/README.md",
		);
	}
}
