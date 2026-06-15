/**
 * FirstRunService — drives the one-time setup flow the first time an owner
 * boots their agent (collecting name, time zone, primary channels, model
 * provider, …). The flow is structurally a state machine over a finite set of
 * checkpoints.
 *
 * STUB — placeholder for the future core-resident first-run service.
 *
 * TODO(migrate: plugins/plugin-personal-assistant/src/lifeops/first-run ->
 *               packages/core/src/owner-state/first-run.ts)
 */

export interface FirstRunCheckpoint {
	readonly id: string;
	readonly completed: boolean;
	readonly completedAt?: string;
}

export interface FirstRunStatus {
	readonly completed: boolean;
	/** The checkpoint the flow is currently waiting on, if any. */
	readonly currentCheckpoint: string | null;
	readonly checkpoints: readonly FirstRunCheckpoint[];
}

export interface FirstRunService {
	getStatus(): Promise<FirstRunStatus>;
	markCheckpoint(id: string): Promise<void>;
	reset(): Promise<void>;
}

export class StubFirstRunService implements FirstRunService {
	async getStatus(): Promise<FirstRunStatus> {
		throw new Error(
			"[StubFirstRunService] not implemented — see packages/core/src/owner-state/README.md",
		);
	}

	async markCheckpoint(_id: string): Promise<void> {
		throw new Error(
			"[StubFirstRunService] not implemented — see packages/core/src/owner-state/README.md",
		);
	}

	async reset(): Promise<void> {
		throw new Error(
			"[StubFirstRunService] not implemented — see packages/core/src/owner-state/README.md",
		);
	}
}
