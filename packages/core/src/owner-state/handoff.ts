/**
 * HandoffStore — tracks transitions between autonomous agent operation and
 * direct owner control (e.g. "the owner has taken over this conversation",
 * "owner is back from a meeting").
 *
 * STUB — placeholder for the future core-resident handoff store.
 *
 * TODO(migrate: plugins/plugin-personal-assistant/src/lifeops/handoff ->
 *               packages/core/src/owner-state/handoff.ts)
 */

export type HandoffActor = "agent" | "owner";

export interface HandoffRecord {
	readonly id: string;
	/** Who currently owns the interaction surface. */
	readonly actor: HandoffActor;
	/** ISO timestamp the handoff was recorded. */
	readonly at: string;
	/** Optional context — channel/room/scope this handoff applies to. */
	readonly scope?: string;
	/** Optional free-form reason ("owner replied directly", …). */
	readonly reason?: string;
}

export interface HandoffStore {
	getCurrent(scope?: string): Promise<HandoffRecord | null>;
	recordHandoff(
		actor: HandoffActor,
		opts?: { scope?: string; reason?: string },
	): Promise<HandoffRecord>;
	listRecent(limit?: number): Promise<readonly HandoffRecord[]>;
}

/**
 * Stub implementation — methods throw. Real implementation is migrated later.
 */
export class StubHandoffStore implements HandoffStore {
	async getCurrent(_scope?: string): Promise<HandoffRecord | null> {
		throw new Error(
			"[StubHandoffStore] not implemented — see packages/core/src/owner-state/README.md",
		);
	}

	async recordHandoff(
		_actor: HandoffActor,
		_opts?: { scope?: string; reason?: string },
	): Promise<HandoffRecord> {
		throw new Error(
			"[StubHandoffStore] not implemented — see packages/core/src/owner-state/README.md",
		);
	}

	async listRecent(_limit?: number): Promise<readonly HandoffRecord[]> {
		throw new Error(
			"[StubHandoffStore] not implemented — see packages/core/src/owner-state/README.md",
		);
	}
}
