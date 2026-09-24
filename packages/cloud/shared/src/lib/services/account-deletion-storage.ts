/** Reconciles local storage metadata only under the current irreversible deletion lease and a fresh provider absence observation. Immutable read receipts require unified financial retention before this phase can complete. */
import { ElizaError } from "@elizaos/core";
import { eq, sql } from "drizzle-orm";
import { dbWrite } from "../../db/helpers";
import {
  orgStorageDeleteOperations,
  orgStorageGcOutbox,
  orgStorageObjects,
  orgStoragePutOperations,
} from "../../db/schemas/org-storage-mutations";
import { orgStorageReadOperations } from "../../db/schemas/org-storage-reads";
import type { AccountDeletionProviderContext } from "./account-deletion-saga";

type StorageDeletionAuthority = Pick<
  AccountDeletionProviderContext,
  | "organizationId"
  | "userId"
  | "requestId"
  | "requestDigest"
  | "lifecycleRevision"
  | "phaseReceiptId"
  | "phaseGeneration"
>;

/** Locks canonical subject and phase authority before observing or removing tenant metadata. */
export async function reconcileAccountDeletionStorage(
  context: StorageDeletionAuthority,
  providerIsAbsent: () => Promise<boolean>,
): Promise<"provider_present" | "retained_reads" | "absent"> {
  return dbWrite.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT id FROM organizations WHERE id=${context.organizationId} FOR UPDATE`,
    );
    await tx.execute(sql`SELECT id FROM users WHERE id=${context.userId} FOR UPDATE`);
    await tx.execute(
      sql`SELECT id FROM account_deletion_requests WHERE id=${context.requestId} FOR UPDATE`,
    );
    await tx.execute(
      sql`SELECT id FROM account_deletion_phase_receipts WHERE id=${context.phaseReceiptId} FOR UPDATE`,
    );
    const validate = async () => {
      const result = await tx.execute(sql`SELECT r.id FROM account_deletion_requests r
        JOIN organizations o ON o.id=r.organization_id
        JOIN users u ON u.id=r.user_id
        JOIN account_deletion_phase_receipts p ON p.request_id=r.id
        WHERE r.id=${context.requestId} AND r.organization_id=${context.organizationId}
          AND r.user_id=${context.userId} AND r.request_digest=${context.requestDigest}
          AND r.lifecycle_revision=${context.lifecycleRevision}
          AND r.status='processing' AND r.irreversible_at IS NOT NULL
          AND o.account_lifecycle_state='deletion_irreversible'
          AND o.account_deletion_request_id=r.id AND o.account_lifecycle_revision=r.lifecycle_revision
          AND u.organization_id=o.id AND u.account_lifecycle_state='deletion_irreversible'
          AND u.account_deletion_request_id=r.id AND u.account_lifecycle_revision=r.lifecycle_revision
          AND p.id=${context.phaseReceiptId} AND p.phase='primary_object_storage'
          AND p.lease_generation=${context.phaseGeneration}
          AND p.status IN ('leased','calling','reconciling')
          AND isfinite(p.lease_expires_at)
          AND (p.lease_expires_at AT TIME ZONE 'UTC')>clock_timestamp()`);
      if (result.rows.length !== 1)
        throw new ElizaError("Storage cleanup requires a current irreversible deletion phase", {
          code: "ACCOUNT_DELETION_STORAGE_AUTHORITY_STALE",
        });
    };
    await validate();
    if (!(await providerIsAbsent())) return "provider_present";
    // Network inspection can outlive the phase lease even while its row is locked.
    await validate();
    const [read] = await tx
      .select({ id: orgStorageReadOperations.id })
      .from(orgStorageReadOperations)
      .where(eq(orgStorageReadOperations.organization_id, context.organizationId))
      .limit(1);
    if (read) return "retained_reads";
    await tx
      .delete(orgStorageDeleteOperations)
      .where(eq(orgStorageDeleteOperations.organization_id, context.organizationId));
    await tx
      .delete(orgStorageGcOutbox)
      .where(eq(orgStorageGcOutbox.organization_id, context.organizationId));
    await tx
      .delete(orgStoragePutOperations)
      .where(eq(orgStoragePutOperations.organization_id, context.organizationId));
    await tx
      .delete(orgStorageObjects)
      .where(eq(orgStorageObjects.organization_id, context.organizationId));
    return "absent";
  });
}
