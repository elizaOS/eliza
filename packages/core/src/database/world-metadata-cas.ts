/**
 * Shared value-comparison and revision helpers protect world metadata across
 * compare-and-swap and legacy whole-world adapter writes.
 */

import { ElizaError } from "../errors";
import type { Metadata } from "../types/primitives";
import { isPlainObject } from "../utils/type-guards";

/** Adapter-owned optimistic revision stored with each world's metadata. */
export const WORLD_METADATA_REVISION_KEY =
	"__eliza_world_metadata_revision" as const;

/**
 * Compare JSON values with PostgreSQL jsonb semantics: object key order is
 * irrelevant and `undefined` properties are absent.
 */
export function worldMetadataValueEquals(
	left: unknown,
	right: unknown,
): boolean {
	if (left === right) return true;
	if (Array.isArray(left) && Array.isArray(right)) {
		return (
			left.length === right.length &&
			left.every((item, index) => worldMetadataValueEquals(item, right[index]))
		);
	}
	if (isPlainObject(left) && isPlainObject(right)) {
		const leftKeys = Object.keys(left).filter(
			(key) => (left as Record<string, unknown>)[key] !== undefined,
		);
		const rightKeys = Object.keys(right).filter(
			(key) => (right as Record<string, unknown>)[key] !== undefined,
		);
		if (leftKeys.length !== rightKeys.length) return false;
		return leftKeys.every(
			(key) =>
				Object.hasOwn(right, key) &&
				worldMetadataValueEquals(
					(left as Record<string, unknown>)[key],
					(right as Record<string, unknown>)[key],
				),
		);
	}
	return false;
}

/**
 * Read the adapter-owned revision. Worlds written before the revision contract
 * start at zero; malformed explicit values fail closed.
 */
export function getWorldMetadataRevision(
	metadata: Metadata | undefined,
): number | null {
	const value = metadata?.[WORLD_METADATA_REVISION_KEY];
	if (value === undefined) return 0;
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
		? value
		: null;
}

/**
 * Require a legacy whole-world writer to carry the revision it read. A stale
 * or malformed request is an observable failure, never a silent lost update.
 */
export function requireFreshWorldMetadataRevision(
	storedMetadata: Metadata | undefined,
	writerMetadata: Metadata | undefined,
	worldId: string,
): number {
	const storedRevision = getWorldMetadataRevision(storedMetadata);
	const writerRevision = getWorldMetadataRevision(writerMetadata);
	if (
		storedRevision === null ||
		writerRevision === null ||
		storedRevision !== writerRevision
	) {
		throw new ElizaError("World metadata write used a stale revision", {
			code: "WORLD_METADATA_STALE_WRITE",
			context: {
				worldId,
				storedRevision,
				writerRevision,
				reason:
					storedRevision === null || writerRevision === null
						? "malformed_revision"
						: "revision_mismatch",
			},
		});
	}
	return storedRevision;
}

/** Merge caller metadata while retaining the adapter-owned stored revision. */
export function mergeWorldMetadataForLegacyWrite(
	storedMetadata: Metadata | undefined,
	incomingMetadata: Metadata | undefined,
	worldId: string,
): Metadata {
	const storedRevision = getWorldMetadataRevision(storedMetadata);
	if (storedRevision === null) {
		throw new ElizaError("Stored world metadata revision is malformed", {
			code: "WORLD_METADATA_STALE_WRITE",
			context: { worldId, storedRevision, reason: "malformed_revision" },
		});
	}
	const stored = structuredClone(storedMetadata ?? {}) as Metadata;
	const incoming = structuredClone(incomingMetadata ?? {}) as Metadata;
	// Connector ownership and role maps are authority state, not ordinary
	// connector observations. Existing worlds must never replace them with a
	// newly constructed owner-only projection during message ingestion.
	delete incoming.roles;
	delete incoming.roleSources;
	return {
		...stored,
		...incoming,
		...(stored.roles === undefined ? {} : { roles: stored.roles }),
		...(stored.roleSources === undefined
			? {}
			: { roleSources: stored.roleSources }),
		[WORLD_METADATA_REVISION_KEY]: storedRevision,
	};
}

/** Clone metadata and advance its adapter-owned optimistic revision. */
export function advanceWorldMetadataRevision(
	metadata: Metadata | undefined,
	currentRevision: number,
): Metadata {
	if (!Number.isSafeInteger(currentRevision) || currentRevision < 0) {
		throw new ElizaError("World metadata revision is invalid", {
			code: "WORLD_METADATA_REVISION_INVALID",
			context: { currentRevision },
		});
	}
	if (currentRevision === Number.MAX_SAFE_INTEGER) {
		throw new ElizaError("World metadata revision is exhausted", {
			code: "WORLD_METADATA_REVISION_EXHAUSTED",
		});
	}
	const replacement = structuredClone(metadata ?? {}) as Metadata;
	replacement[WORLD_METADATA_REVISION_KEY] = currentRevision + 1;
	return replacement;
}

/** Normalize a newly created world's revision without trusting caller input. */
export function initializeWorldMetadataRevision(
	metadata: Metadata | undefined,
): Metadata {
	const replacement = structuredClone(metadata ?? {}) as Metadata;
	replacement[WORLD_METADATA_REVISION_KEY] = 0;
	return replacement;
}
