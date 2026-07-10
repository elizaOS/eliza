// Persists PII scrub done-marker records for cloud services through the shared DB boundary.
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import {
  type NewPiiScrubMarker,
  type PiiScrubMarker,
  piiScrubMarkers,
} from "../schemas/pii-scrub-markers";

export type { NewPiiScrubMarker, PiiScrubMarker };

/**
 * Prefix of every PII scrub done-marker key. MUST stay identical to
 * `PII_SCRUB_MARKER_PREFIX` in `packages/core/src/security/pii-scrub-markers.ts`
 * — the LOCAL and CLOUD lanes share one content-addressed key space shape
 * (`pii:<sha256(content)>:v<rulesetVersion>`) so scrub work never duplicates
 * across lanes. A lockstep test asserts the two builders agree
 * (`pii-scrub-jobs.test.ts`).
 */
export const PII_SCRUB_MARKER_PREFIX = "pii";

/**
 * Hex sha256 of the content being scrubbed — the content-address half of the
 * marker key. A pure function of the bytes: identical content always hashes
 * identically, so it is the stable cross-lane idempotency handle.
 */
export function hashPiiScrubContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Build the done-marker key `pii:<sha256(content)>:v<rulesetVersion>` from an
 * already-computed content hash. Same contract as the core builder: an empty
 * ruleset version would collapse the marker namespace across ruleset upgrades
 * and let a stale-ruleset scrub pass as current (a fail-open we refuse).
 */
export function piiScrubMarkerKey(contentHash: string, rulesetVersion: string): string {
  if (typeof rulesetVersion !== "string" || rulesetVersion.length === 0) {
    throw new Error(
      "[pii-scrub-markers] rulesetVersion must be a non-empty string; refusing to build a version-collapsed marker key",
    );
  }
  if (typeof contentHash !== "string" || contentHash.length === 0) {
    throw new Error("[pii-scrub-markers] contentHash must be a non-empty string");
  }
  return `${PII_SCRUB_MARKER_PREFIX}:${contentHash}:v${rulesetVersion}`;
}

/** Build the done-marker key directly from raw content. */
export function piiScrubMarkerKeyForContent(content: string, rulesetVersion: string): string {
  return piiScrubMarkerKey(hashPiiScrubContent(content), rulesetVersion);
}

/**
 * Repository for the tenant-scoped PII scrub done-markers (#14808 CLOUD lane).
 *
 * The write path is `tryCreate` (INSERT ... ON CONFLICT DO NOTHING on the
 * per-org unique key) — the same two-tier dedupe shape as
 * `webhookEventsRepository.tryCreate`: a lost race is the `created: false`
 * branch, never a duplicate side effect, while a genuine DB failure still
 * propagates loudly.
 */
export class PiiScrubMarkersRepository {
  // ============================================================================
  // READ OPERATIONS (use read-intent connection)
  // ============================================================================

  /** Find a marker by its org-scoped key. */
  async findByKey(organizationId: string, markerKey: string): Promise<PiiScrubMarker | undefined> {
    const [row] = await dbRead
      .select()
      .from(piiScrubMarkers)
      .where(
        and(
          eq(piiScrubMarkers.organization_id, organizationId),
          eq(piiScrubMarkers.marker_key, markerKey),
        ),
      )
      .limit(1);
    return row;
  }

  /**
   * True when this exact content has already been scrubbed under this exact
   * ruleset version FOR THIS ORG — the idempotency check the drain runs before
   * any executor call.
   */
  async isDone(organizationId: string, markerKey: string): Promise<boolean> {
    return (await this.findByKey(organizationId, markerKey)) !== undefined;
  }

  /** All markers written by a given job (audit/evidence; test helper). */
  async listByJob(organizationId: string, jobId: string): Promise<PiiScrubMarker[]> {
    return await dbRead
      .select()
      .from(piiScrubMarkers)
      .where(
        and(eq(piiScrubMarkers.organization_id, organizationId), eq(piiScrubMarkers.job_id, jobId)),
      )
      .orderBy(piiScrubMarkers.created_at);
  }

  // ============================================================================
  // WRITE OPERATIONS (use primary)
  // ============================================================================

  /**
   * Atomically record a completed scrub item. Returns `{ created: false }`
   * when the (org, key) marker already exists — a concurrent worker or a
   * previous attempt finished this item first; the caller treats that as a
   * benign skip, never a failure. Call ONLY after the item's scrub fully
   * succeeded: an item that failed must stay unmarked (quarantined for retry).
   */
  async tryCreate(
    data: NewPiiScrubMarker,
  ): Promise<{ created: true; marker: PiiScrubMarker } | { created: false }> {
    const [marker] = await dbWrite
      .insert(piiScrubMarkers)
      .values(data)
      .onConflictDoNothing({
        target: [piiScrubMarkers.organization_id, piiScrubMarkers.marker_key],
      })
      .returning();
    if (!marker) {
      return { created: false };
    }
    return { created: true, marker };
  }
}

export const piiScrubMarkersRepository = new PiiScrubMarkersRepository();
