/**
 * EventKindRegistry — registry of structured event kinds that the runtime and
 * features emit (e.g. "lifeops.task.fired", "lifeops.handoff.recorded"). A
 * single registry keeps event names canonical and lets consumers introspect
 * the available surface.
 *
 * STUB — see this directory's README for the tracked migration.
 *
 * TODO(migrate: plugins/plugin-personal-assistant/src/lifeops/registries/event-kind.ts ->
 *               packages/core/src/registries/event-kind.ts)
 */

export interface EventKindDefinition {
	readonly id: string;
	/** Free-form category — "scheduling", "approval", "messaging", … */
	readonly category?: string;
	readonly description?: string;
}

export interface EventKindRegistry {
	register(kind: EventKindDefinition): void;
	get(id: string): EventKindDefinition | undefined;
	list(): readonly EventKindDefinition[];
}

export class StubEventKindRegistry implements EventKindRegistry {
	register(_kind: EventKindDefinition): void {
		throw new Error(
			"[StubEventKindRegistry] not implemented — see packages/core/src/registries/README.md",
		);
	}

	get(_id: string): EventKindDefinition | undefined {
		throw new Error(
			"[StubEventKindRegistry] not implemented — see packages/core/src/registries/README.md",
		);
	}

	list(): readonly EventKindDefinition[] {
		throw new Error(
			"[StubEventKindRegistry] not implemented — see packages/core/src/registries/README.md",
		);
	}
}
