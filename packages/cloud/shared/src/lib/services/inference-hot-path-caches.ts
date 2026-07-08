/**
 * Flag for the Tier-3 in-isolate DECISION caches on the inference hot path
 * (#9899): the org rate-limit lease (`middleware/rate-limit.ts`), the
 * `shouldBlockUser` memo (`content-moderation.ts`), and the per-model catalog
 * memo (`model-catalog.ts`).
 *
 * Deliberately a SEPARATE flag from `INFERENCE_DEFERRED_ADMISSION`: these
 * caches are orthogonal to billing admission (they trade bounded read
 * staleness for round-trips on any config), so coupling their rollback to the
 * billing flag would be wrong in both directions. Default OFF — flag off is
 * byte-identical to today's behavior, so "rollback = flip the flag" covers
 * every behavior change this tier ships.
 */

import { getCloudAwareEnv } from "../runtime/cloud-bindings";

type StringEnv = Record<string, string | undefined>;

export function isHotPathCachesEnabled(env: StringEnv = getCloudAwareEnv()): boolean {
  return (env.INFERENCE_HOT_PATH_CACHES ?? "").trim() === "true";
}
