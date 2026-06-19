/**
 * BlockerRegistry — registry of named blockers (apps, sites, categories) the
 * focus / distraction-control feature can apply. Other features reference
 * blockers by id without owning the blocker catalog.
 *
 * STUB — see this directory's README for the tracked migration.
 *
 * TODO(migrate: plugins/plugin-personal-assistant/src/lifeops/registries/blocker.ts ->
 *               packages/core/src/registries/blocker.ts)
 */

export type BlockerTargetKind = "app" | "site" | "category";

export interface BlockerDefinition {
	readonly id: string;
	readonly label: string;
	readonly targetKind: BlockerTargetKind;
	/** Implementation-specific target identifier (bundle id, domain, …). */
	readonly target: string;
}

export interface BlockerRegistry {
	register(blocker: BlockerDefinition): void;
	get(id: string): BlockerDefinition | undefined;
	list(): readonly BlockerDefinition[];
}

export class StubBlockerRegistry implements BlockerRegistry {
	register(_blocker: BlockerDefinition): void {
		throw new Error(
			"[StubBlockerRegistry] not implemented — see packages/core/src/registries/README.md",
		);
	}

	get(_id: string): BlockerDefinition | undefined {
		throw new Error(
			"[StubBlockerRegistry] not implemented — see packages/core/src/registries/README.md",
		);
	}

	list(): readonly BlockerDefinition[] {
		throw new Error(
			"[StubBlockerRegistry] not implemented — see packages/core/src/registries/README.md",
		);
	}
}
