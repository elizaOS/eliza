/**
 * AnchorRegistry — registry of "anchors": named points in the owner's day or
 * week that other features can reference (e.g. "wake", "work-start",
 * "school-pickup"). Anchors are how scheduled tasks express *when* they fire
 * without each feature inventing its own clock vocabulary.
 *
 * STUB — see this directory's README for the tracked migration.
 *
 * TODO(migrate: plugins/plugin-personal-assistant/src/lifeops/registries/anchor.ts ->
 *               packages/core/src/registries/anchor.ts)
 */

export interface AnchorDefinition {
	readonly id: string;
	readonly label: string;
	/** Free-form classification — "daily", "weekly", "event-driven", … */
	readonly kind?: string;
	/** Optional default time expression. Format owned by the implementation. */
	readonly defaultAt?: string;
}

export interface AnchorRegistry {
	register(anchor: AnchorDefinition): void;
	get(id: string): AnchorDefinition | undefined;
	list(): readonly AnchorDefinition[];
}

export class StubAnchorRegistry implements AnchorRegistry {
	register(_anchor: AnchorDefinition): void {
		throw new Error(
			"[StubAnchorRegistry] not implemented — see packages/core/src/registries/README.md",
		);
	}

	get(_id: string): AnchorDefinition | undefined {
		throw new Error(
			"[StubAnchorRegistry] not implemented — see packages/core/src/registries/README.md",
		);
	}

	list(): readonly AnchorDefinition[] {
		throw new Error(
			"[StubAnchorRegistry] not implemented — see packages/core/src/registries/README.md",
		);
	}
}
