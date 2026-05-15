import type { ActivityProfile } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isActivityProfile(value: unknown): value is ActivityProfile {
  if (!isRecord(value)) return false;
  return (
    typeof value.analyzedAt === "number" &&
    typeof value.ownerEntityId === "string" &&
    typeof value.totalMessages === "number"
  );
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
  // Reject profiles missing required shape fields (corrupt or stale version)
  return isActivityProfile(candidate) ? candidate : null;
}
