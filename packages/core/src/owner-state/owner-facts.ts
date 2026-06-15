/**
 * OwnerFactsStore — stable, slow-changing facts the agent knows about its owner.
 *
 * STUB — placeholder for the future core-resident owner-facts store.
 * The current implementation lives in
 *   plugins/plugin-personal-assistant/src/lifeops/owner
 * and will migrate here once the rest of the workspace catches up.
 *
 * TODO(migrate: plugins/plugin-personal-assistant/src/lifeops/owner ->
 *               packages/core/src/owner-state/owner-facts.ts)
 */

/**
 * A single fact about the owner. The `value` is intentionally `unknown` because
 * facts can hold arbitrary JSON-serializable payloads (strings, structured
 * preferences, addresses, etc.).
 */
export interface OwnerFact {
	/** Stable identifier — e.g. "name", "timezone", "home_address". */
	readonly key: string;
	/** The fact's payload. Shape is fact-specific. */
	readonly value: unknown;
	/** ISO timestamp of the last write. */
	readonly updatedAt: string;
	/** Optional provenance — where the fact came from (action, message id, …). */
	readonly source?: string;
}

/**
 * Contract for reading and writing owner facts.
 *
 * Implementations are responsible for persistence and concurrency; this
 * interface only specifies the surface area consumers can rely on.
 */
export interface OwnerFactsStore {
	getFact(key: string): Promise<OwnerFact | null>;
	setFact(key: string, value: unknown, source?: string): Promise<void>;
	listFacts(): Promise<readonly OwnerFact[]>;
}

/**
 * Stub implementation. All methods throw. Replace with the real implementation
 * during the migration tracked in this directory's README.
 */
export class StubOwnerFactsStore implements OwnerFactsStore {
	async getFact(_key: string): Promise<OwnerFact | null> {
		throw new Error(
			"[StubOwnerFactsStore] not implemented — see packages/core/src/owner-state/README.md",
		);
	}

	async setFact(
		_key: string,
		_value: unknown,
		_source?: string,
	): Promise<void> {
		throw new Error(
			"[StubOwnerFactsStore] not implemented — see packages/core/src/owner-state/README.md",
		);
	}

	async listFacts(): Promise<readonly OwnerFact[]> {
		throw new Error(
			"[StubOwnerFactsStore] not implemented — see packages/core/src/owner-state/README.md",
		);
	}
}
