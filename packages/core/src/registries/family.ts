/**
 * FamilyRegistry — registry of the owner's family members (and family-equivalent
 * relations) the agent should be aware of. This is *not* a contact list; it's
 * the curated subset of people whose presence/needs gate behavior elsewhere
 * (school pickups, anniversaries, escalation when something happens to a kid).
 *
 * STUB — see this directory's README for the tracked migration.
 *
 * TODO(migrate: plugins/plugin-personal-assistant/src/lifeops/registries/family.ts ->
 *               packages/core/src/registries/family.ts)
 */

export interface FamilyMember {
	readonly id: string;
	readonly displayName: string;
	/** Relationship label — "spouse", "child", "parent", … */
	readonly relation: string;
	/** Optional structured metadata (DOB, time zone, …). */
	readonly metadata?: Record<string, unknown>;
}

export interface FamilyRegistry {
	register(member: FamilyMember): void;
	get(id: string): FamilyMember | undefined;
	list(): readonly FamilyMember[];
}

export class StubFamilyRegistry implements FamilyRegistry {
	register(_member: FamilyMember): void {
		throw new Error(
			"[StubFamilyRegistry] not implemented — see packages/core/src/registries/README.md",
		);
	}

	get(_id: string): FamilyMember | undefined {
		throw new Error(
			"[StubFamilyRegistry] not implemented — see packages/core/src/registries/README.md",
		);
	}

	list(): readonly FamilyMember[] {
		throw new Error(
			"[StubFamilyRegistry] not implemented — see packages/core/src/registries/README.md",
		);
	}
}
