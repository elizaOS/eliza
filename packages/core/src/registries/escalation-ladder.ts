/**
 * EscalationLadderRegistry — registry of named escalation ladders. A ladder is
 * an ordered sequence of steps the agent climbs when a task is not acknowledged
 * (e.g. nudge → DM → call → fallback). Centralizing the ladder shape lets
 * features pick a ladder by name instead of redefining the cadence inline.
 *
 * STUB — see this directory's README for the tracked migration.
 *
 * TODO(migrate: plugins/plugin-personal-assistant/src/lifeops/registries/escalation-ladder.ts ->
 *               packages/core/src/registries/escalation-ladder.ts)
 */

export interface EscalationStep {
	readonly id: string;
	/** Delay before this step fires, expressed as an opaque duration string. */
	readonly after: string;
	/** Optional channel hint ("dm", "sms", "call"). */
	readonly channel?: string;
	/** Optional handler tag, looked up by the runner. */
	readonly handler?: string;
}

export interface EscalationLadderDefinition {
	readonly id: string;
	readonly steps: readonly EscalationStep[];
}

export interface EscalationLadderRegistry {
	register(ladder: EscalationLadderDefinition): void;
	get(id: string): EscalationLadderDefinition | undefined;
	list(): readonly EscalationLadderDefinition[];
}

export class StubEscalationLadderRegistry implements EscalationLadderRegistry {
	register(_ladder: EscalationLadderDefinition): void {
		throw new Error(
			"[StubEscalationLadderRegistry] not implemented — see packages/core/src/registries/README.md",
		);
	}

	get(_id: string): EscalationLadderDefinition | undefined {
		throw new Error(
			"[StubEscalationLadderRegistry] not implemented — see packages/core/src/registries/README.md",
		);
	}

	list(): readonly EscalationLadderDefinition[] {
		throw new Error(
			"[StubEscalationLadderRegistry] not implemented — see packages/core/src/registries/README.md",
		);
	}
}
