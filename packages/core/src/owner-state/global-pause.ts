/**
 * GlobalPauseStore — a single-flag kill-switch the owner can flip to stop the
 * agent from initiating outbound actions (sending messages, executing schedules,
 * etc.). Read-side checks are scattered across many features; centralizing the
 * pause flag here keeps the contract single-source.
 *
 * STUB — placeholder for the future core-resident global-pause store.
 *
 * TODO(migrate: plugins/plugin-personal-assistant/src/lifeops/global-pause ->
 *               packages/core/src/owner-state/global-pause.ts)
 */

export interface GlobalPauseState {
	readonly paused: boolean;
	/** ISO timestamp of the last state change, or null if never set. */
	readonly since: string | null;
	/** Optional free-form reason ("on vacation", "debugging", …). */
	readonly reason?: string;
}

export interface GlobalPauseStore {
	isPaused(): Promise<boolean>;
	getState(): Promise<GlobalPauseState>;
	pause(reason?: string): Promise<void>;
	resume(): Promise<void>;
}

export class StubGlobalPauseStore implements GlobalPauseStore {
	async isPaused(): Promise<boolean> {
		throw new Error(
			"[StubGlobalPauseStore] not implemented — see packages/core/src/owner-state/README.md",
		);
	}

	async getState(): Promise<GlobalPauseState> {
		throw new Error(
			"[StubGlobalPauseStore] not implemented — see packages/core/src/owner-state/README.md",
		);
	}

	async pause(_reason?: string): Promise<void> {
		throw new Error(
			"[StubGlobalPauseStore] not implemented — see packages/core/src/owner-state/README.md",
		);
	}

	async resume(): Promise<void> {
		throw new Error(
			"[StubGlobalPauseStore] not implemented — see packages/core/src/owner-state/README.md",
		);
	}
}
