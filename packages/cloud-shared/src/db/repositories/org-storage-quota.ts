import { eq, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import {
  type NewOrgStorageQuota,
  type OrgStorageQuota,
  orgStorageQuota,
} from "../schemas/org-storage-quota";

export type { NewOrgStorageQuota, OrgStorageQuota };

/**
 * Free-tier byte limit. Mirrors the SQL default in
 * `0102_add_org_storage_quota.sql` so callers that touch the table before
 * the row exists see the same number.
 */
export const DEFAULT_ORG_STORAGE_BYTES_LIMIT = 5n * 1024n * 1024n * 1024n;

/**
 * Repository for per-organization attachment storage quotas.
 *
 * Only the route handler in `apps/api/v1/apis/storage` calls this. Reads
 * use the read-intent connection; writes use the primary. There is no soft limit:
 * `tryReserveBytes` returns `null` when the requested write would push the
 * org above its `bytes_limit`, and the caller surfaces a 413.
 */
export class OrgStorageQuotaRepository {
  async findByOrganization(organizationId: string): Promise<OrgStorageQuota | undefined> {
    return await dbRead.query.orgStorageQuota.findFirst({
      where: eq(orgStorageQuota.organization_id, organizationId),
    });
  }

  /**
   * Atomically attempts to reserve `bytes` against an organization's quota.
   *
   * Returns the post-write `bytes_used` on success, or `null` if the write
   * would exceed `bytes_limit`. Implemented as a single conditional UPDATE
   * so concurrent requests cannot race past the limit.
   *
   * Inserts a default-limit row on first use.
   */
  async tryReserveBytes(organizationId: string, bytes: bigint): Promise<bigint | null> {
    if (bytes < 0n) {
      throw new Error("OrgStorageQuotaRepository.tryReserveBytes: bytes must be non-negative");
    }

    await dbWrite
      .insert(orgStorageQuota)
      .values({
        organization_id: organizationId,
        bytes_used: 0n,
        bytes_limit: DEFAULT_ORG_STORAGE_BYTES_LIMIT,
      })
      .onConflictDoNothing();

    const updated = await dbWrite
      .update(orgStorageQuota)
      .set({
        bytes_used: sql`${orgStorageQuota.bytes_used} + ${bytes}`,
        updated_at: new Date(),
      })
      .where(
        sql`${orgStorageQuota.organization_id} = ${organizationId} AND ${orgStorageQuota.bytes_used} + ${bytes} <= ${orgStorageQuota.bytes_limit}`,
      )
      .returning({ bytes_used: orgStorageQuota.bytes_used });

    if (updated.length === 0) {
      return null;
    }
    return updated[0].bytes_used;
  }

  /**
   * Atomically releases `bytes` back to an organization's quota. Clamped at
   * zero so a double-decrement (e.g. delete-after-failed-put) cannot drive
   * the counter negative.
   */
  async releaseBytes(organizationId: string, bytes: bigint): Promise<void> {
    if (bytes <= 0n) {
      return;
    }
    await dbWrite
      .update(orgStorageQuota)
      .set({
        bytes_used: sql`GREATEST(${orgStorageQuota.bytes_used} - ${bytes}, 0)`,
        updated_at: new Date(),
      })
      .where(eq(orgStorageQuota.organization_id, organizationId));
  }

  /**
   * Sets the byte limit for an organization. Used by tier upgrades.
   * Inserts a default-counter row if missing so the limit takes effect
   * even before the org's first write.
   */
  async setBytesLimit(organizationId: string, bytesLimit: bigint): Promise<void> {
    if (bytesLimit < 0n) {
      throw new Error("OrgStorageQuotaRepository.setBytesLimit: bytesLimit must be non-negative");
    }
    await dbWrite
      .insert(orgStorageQuota)
      .values({
        organization_id: organizationId,
        bytes_used: 0n,
        bytes_limit: bytesLimit,
      })
      .onConflictDoUpdate({
        target: orgStorageQuota.organization_id,
        set: { bytes_limit: bytesLimit, updated_at: new Date() },
      });
  }
}

export const orgStorageQuotaRepository = new OrgStorageQuotaRepository();
