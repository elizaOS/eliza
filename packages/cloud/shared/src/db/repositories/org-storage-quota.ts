/** Reserves storage against transaction-current organization policy and records explicitly authorized storage overrides. */

import { eq, sql } from "drizzle-orm";
import {
  readOrganizationQuotaPolicyInTransaction,
  requireOrganizationResourceLimit,
} from "../../lib/services/organization-quota-policy";
import { dbRead, dbWrite, writeTransaction } from "../helpers";
import {
  type NewOrgStorageQuota,
  type OrgStorageQuota,
  orgStorageQuota,
} from "../schemas/org-storage-quota";
import {
  advanceOrganizationPolicyGeneration,
  lockOrganizationPolicy,
} from "./organization-policy-generation";

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
 * Storage proxy and direct object-upload routes call this boundary. Reads use
 * the read-intent connection; writes use the primary. There is no soft limit:
 * `tryReserveBytes` returns `null` when the requested write would push the
 * organization above its `bytes_limit`, and the caller surfaces a 413.
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

    return writeTransaction(async (tx) => {
      await lockOrganizationPolicy(tx, organizationId);
      const policy = await readOrganizationQuotaPolicyInTransaction(tx, organizationId);
      const ceiling = requireOrganizationResourceLimit(policy, "storage");
      await tx
        .insert(orgStorageQuota)
        .values({
          organization_id: organizationId,
          bytes_used: 0n,
          bytes_limit: DEFAULT_ORG_STORAGE_BYTES_LIMIT,
        })
        .onConflictDoNothing();

      const updated = await tx
        .update(orgStorageQuota)
        .set({
          bytes_used: sql`${orgStorageQuota.bytes_used} + ${bytes}`,
          updated_at: new Date(),
        })
        .where(
          sql`${orgStorageQuota.organization_id} = ${organizationId} AND ${orgStorageQuota.bytes_used} + ${bytes} <= ${ceiling}`,
        )
        .returning({ bytes_used: orgStorageQuota.bytes_used });

      if (updated.length === 0) {
        return null;
      }
      return updated[0].bytes_used;
    });
  }

  /**
   * Atomically releases `bytes` back to an organization's quota. Clamped at
   * zero so a repeated compensating release cannot drive the counter negative.
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
  async setBytesLimit(organizationId: string, bytesLimit: bigint, actor: string): Promise<void> {
    if (bytesLimit < 0n) {
      throw new Error("OrgStorageQuotaRepository.setBytesLimit: bytesLimit must be non-negative");
    }
    await writeTransaction(async (tx) => {
      await lockOrganizationPolicy(tx, organizationId);
      const [before] = await tx
        .select()
        .from(orgStorageQuota)
        .where(eq(orgStorageQuota.organization_id, organizationId));
      await tx
        .insert(orgStorageQuota)
        .values({
          organization_id: organizationId,
          bytes_used: 0n,
          bytes_limit: bytesLimit,
          limit_override_authorized: true,
        })
        .onConflictDoUpdate({
          target: orgStorageQuota.organization_id,
          set: { bytes_limit: bytesLimit, limit_override_authorized: true, updated_at: new Date() },
        });
      if (!before?.limit_override_authorized || before.bytes_limit !== bytesLimit)
        await advanceOrganizationPolicyGeneration(tx, {
          organizationId,
          actor,
          reason: "storage_override_updated",
          change: { bytesLimit: bytesLimit.toString() },
        });
    });
  }
}

export const orgStorageQuotaRepository = new OrgStorageQuotaRepository();
