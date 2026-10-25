// Persists PII scrub done-marker records for cloud services through the shared DB boundary.
import { and, eq, inArray } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import {
  type NewPiiScrubMarker,
  type PiiScrubInspectionScope,
  type PiiScrubMarker,
  piiScrubMarkers,
} from "../schemas/pii-scrub-markers";

export type { NewPiiScrubMarker, PiiScrubInspectionScope, PiiScrubMarker };

/**
 * Marker scopes that satisfy a job requesting `scope`: a server-discovery job
 * is satisfied only by a server-discovery marker; a declared-candidates job by
 * either (server discovery is strictly stronger).
 */
export function satisfyingInspectionScopes(
  scope: PiiScrubInspectionScope,
): readonly PiiScrubInspectionScope[] {
  return scope === "server_discovery"
    ? ["server_discovery"]
    : ["declared_candidates", "server_discovery"];
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

  /** Find a marker by its org-scoped key that satisfies `scope`. */
  async findByKey(
    organizationId: string,
    markerKey: string,
    scope: PiiScrubInspectionScope,
  ): Promise<PiiScrubMarker | undefined> {
    const [row] = await dbRead
      .select()
      .from(piiScrubMarkers)
      .where(
        and(
          eq(piiScrubMarkers.organization_id, organizationId),
          eq(piiScrubMarkers.marker_key, markerKey),
          inArray(piiScrubMarkers.inspection_scope, [...satisfyingInspectionScopes(scope)]),
        ),
      )
      .limit(1);
    return row;
  }

  /**
   * True when this exact content has already been scrubbed under this exact
   * ruleset version FOR THIS ORG at an inspection scope at least as strong as
   * `scope` — the idempotency check the drain runs before any executor call.
   */
  async isDone(
    organizationId: string,
    markerKey: string,
    scope: PiiScrubInspectionScope,
  ): Promise<boolean> {
    return (await this.findByKey(organizationId, markerKey, scope)) !== undefined;
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
   * when the (org, key, scope) marker already exists — a concurrent worker or a
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
        target: [
          piiScrubMarkers.organization_id,
          piiScrubMarkers.marker_key,
          piiScrubMarkers.inspection_scope,
        ],
      })
      .returning();
    if (!marker) {
      return { created: false };
    }
    return { created: true, marker };
  }
}

export const piiScrubMarkersRepository = new PiiScrubMarkersRepository();
