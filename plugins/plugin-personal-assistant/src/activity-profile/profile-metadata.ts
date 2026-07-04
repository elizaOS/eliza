// Supports LifeOps activity and focus projections consumed by owner context.
import type { ActivityProfile } from "./types.js";

/**
 * Name + tags of the `PROACTIVE_AGENT` runtime task, in whose metadata the
 * persisted {@link ActivityProfile} lives. Defined in this lightweight module
 * (rather than `proactive-worker.ts`) so consumers that only need to locate the
 * profile — the activity provider, the scheduled-task gate readers — can import
 * them without pulling the proactive worker's heavy dependency graph.
 */
export const PROACTIVE_TASK_NAME = "PROACTIVE_AGENT" as const;
export const PROACTIVE_TASK_TAGS = ["queue", "repeat", "proactive"] as const;

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
