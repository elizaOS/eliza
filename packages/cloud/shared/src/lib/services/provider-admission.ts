/** Serializes external provider dispatch with irreversible organization lifecycle fencing. */

import { ElizaError } from "@elizaos/core/edge";
import { and, eq, isNull } from "drizzle-orm";
import { dbWrite } from "../../db/helpers";
import { organizations } from "../../db/schemas/organizations";
import { providerAdmissions } from "../../db/schemas/provider-admissions";
import { organizationLifecycleAllowsNewWork } from "./account-lifecycle-authority";

export type ProviderAdmissionOperationKind = "auto_top_up" | "agent_lifecycle";

export interface ProviderAdmissionAuthority {
  organizationId: string;
  operationKind: ProviderAdmissionOperationKind;
  operationId: string;
}

/**
 * Atomically publishes provider intent under the same organization row lock
 * used by deletion activation. Admissions never expire: an abandoned caller
 * must reconcile its durable operation before deletion can proceed.
 */
export async function acquireProviderAdmission(
  authority: ProviderAdmissionAuthority,
  now = new Date(),
): Promise<boolean> {
  return dbWrite.transaction(async (tx) => {
    const [organization] = await tx
      .select()
      .from(organizations)
      .where(eq(organizations.id, authority.organizationId))
      .for("update")
      .limit(1);
    if (!organization) return false;
    const state = organization.account_lifecycle_state;
    if (
      (state !== "active" && state !== "deletion_recovery" && state !== "deletion_irreversible") ||
      !organizationLifecycleAllowsNewWork({
        state,
        revision: organization.account_lifecycle_revision,
        active: organization.is_active,
        deletionRequestId: organization.account_deletion_request_id,
      })
    ) {
      return false;
    }

    const [existing] = await tx
      .select({
        organizationId: providerAdmissions.organization_id,
        releasedAt: providerAdmissions.released_at,
      })
      .from(providerAdmissions)
      .where(
        and(
          eq(providerAdmissions.operation_kind, authority.operationKind),
          eq(providerAdmissions.operation_id, authority.operationId),
        ),
      )
      .for("update")
      .limit(1);
    if (existing) {
      if (existing.organizationId !== authority.organizationId) {
        throw new ElizaError("Provider admission operation belongs to another organization", {
          code: "PROVIDER_ADMISSION_ORGANIZATION_MISMATCH",
          severity: "fatal",
        });
      }
      if (existing.releasedAt === null) return true;
      const [reopened] = await tx
        .update(providerAdmissions)
        .set({ admitted_at: now, released_at: null })
        .where(
          and(
            eq(providerAdmissions.organization_id, authority.organizationId),
            eq(providerAdmissions.operation_kind, authority.operationKind),
            eq(providerAdmissions.operation_id, authority.operationId),
          ),
        )
        .returning({ id: providerAdmissions.id });
      if (!reopened) {
        throw new ElizaError("Provider admission retry was not durably reopened", {
          code: "PROVIDER_ADMISSION_REOPEN_MISSING",
          severity: "fatal",
        });
      }
      return true;
    }

    const [created] = await tx
      .insert(providerAdmissions)
      .values({
        organization_id: authority.organizationId,
        operation_kind: authority.operationKind,
        operation_id: authority.operationId,
        admitted_at: now,
      })
      .returning({ id: providerAdmissions.id });
    if (!created) {
      throw new ElizaError("Provider admission was not durably committed", {
        code: "PROVIDER_ADMISSION_COMMIT_MISSING",
        severity: "fatal",
      });
    }
    return true;
  });
}

/** Release only after the durable operation has recorded a provider outcome. */
export async function releaseProviderAdmission(
  authority: ProviderAdmissionAuthority,
  now = new Date(),
): Promise<void> {
  await dbWrite
    .update(providerAdmissions)
    .set({ released_at: now })
    .where(
      and(
        eq(providerAdmissions.organization_id, authority.organizationId),
        eq(providerAdmissions.operation_kind, authority.operationKind),
        eq(providerAdmissions.operation_id, authority.operationId),
        isNull(providerAdmissions.released_at),
      ),
    );
}
