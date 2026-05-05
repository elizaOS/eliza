import type { ActivityProfile } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Read a previously-persisted {@link ActivityProfile} from entity metadata.
 *
 * Extracted to its own module so that `lifeops/service.ts` can import it
 * without pulling in the full `activity-profile/service.ts` (which itself
 * imports from `lifeops/`), breaking the circular dependency.
 */
export function readProfileFromMetadata(
  metadata: Record<string, unknown> | null,
): ActivityProfile | null {
  if (!metadata?.activityProfile) return null;
  const candidate = metadata.activityProfile;
  if (!isRecord(candidate)) return null;
  // Reject profiles missing required shape fields (corrupt or stale version)
  if (typeof candidate.analyzedAt !== "number") return null;
  if (typeof candidate.ownerEntityId !== "string") return null;
  if (typeof candidate.totalMessages !== "number") return null;
  return candidate as unknown as ActivityProfile;
}
