import type { ArtifactShareGrant, MemoryScope } from "../types/memory.js";
import type { UUID } from "../types/primitives.js";
import { validateUuid } from "../utils/uuid.js";

export function isMemoryScope(value: unknown): value is MemoryScope {
	switch (value) {
		case "shared":
		case "private":
		case "room":
		case "global":
		case "owner-private":
		case "user-private":
		case "agent-private":
			return true;
		default:
			return false;
	}
}

/** Owning entity of a scoped record: `scopedToEntityId`, then `addedBy`, then the record's entity. */
export function scopedEntityIdFromMetadata<T extends UUID | undefined>(
	metadata: { scopedToEntityId?: unknown; addedBy?: unknown } | undefined,
	fallback: T,
): UUID | T {
	const scopedTo = metadata?.scopedToEntityId;
	if (typeof scopedTo === "string") return scopedTo as UUID;
	const addedBy = metadata?.addedBy;
	return typeof addedBy === "string" ? (addedBy as UUID) : fallback;
}

/**
 * Parse untrusted grant entries into typed grants. A grant that cannot be read
 * grants NOTHING (it is dropped, fail closed); it never degrades into a default.
 */
// error-policy:J3 untrusted-input sanitizing — stored jsonb and declared egress
// subjects are untyped; invalid grant entries yield no grant, never a fake one.
export function parseShareGrantList(value: unknown): ArtifactShareGrant[] {
	if (!Array.isArray(value)) return [];
	const out: ArtifactShareGrant[] = [];
	for (const entry of value) {
		if (!entry || typeof entry !== "object") continue;
		const g = entry as Record<string, unknown>;
		const entityId = validateUuid(g.entityId);
		const mode = g.mode;
		if (!entityId) continue;
		if (mode !== "full" && mode !== "redacted") continue;
		const grantedBy = validateUuid(g.grantedBy);
		out.push({
			entityId,
			mode,
			...(grantedBy ? { grantedBy } : {}),
			...(typeof g.grantedAtMs === "number"
				? { grantedAtMs: g.grantedAtMs }
				: {}),
		});
	}
	return out;
}
