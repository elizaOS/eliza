/** Persists audited rate overrides with a durable organization policy generation in the same primary transaction. */
import { eq } from "drizzle-orm";
import { dbRead, writeTransaction } from "../helpers";
import {
  type NewOrgRateLimitOverride,
  type OrgRateLimitOverride,
  orgRateLimitOverrides,
} from "../schemas/org-rate-limit-overrides";

import {
  advanceOrganizationPolicyGeneration,
  lockOrganizationPolicy,
} from "./organization-policy-generation";

export type { NewOrgRateLimitOverride, OrgRateLimitOverride };

/**
 * Repository for per-organization rate limit overrides.
 *
 * Read operations → dbRead (read-intent connection)
 * Write operations → dbWrite (primary)
 */
export class OrgRateLimitOverridesRepository {
  async findByOrganizationId(organizationId: string): Promise<OrgRateLimitOverride | undefined> {
    return await dbRead.query.orgRateLimitOverrides.findFirst({
      where: eq(orgRateLimitOverrides.organization_id, organizationId),
    });
  }

  async upsert(
    data: Pick<NewOrgRateLimitOverride, "organization_id"> &
      Partial<
        Pick<
          NewOrgRateLimitOverride,
          "completions_rpm" | "embeddings_rpm" | "standard_rpm" | "strict_rpm" | "note"
        >
      >,
    actor: string,
  ): Promise<OrgRateLimitOverride> {
    return writeTransaction(async (tx) => {
      await lockOrganizationPolicy(tx, data.organization_id);
      const [before] = await tx
        .select()
        .from(orgRateLimitOverrides)
        .where(eq(orgRateLimitOverrides.organization_id, data.organization_id));
      const [result] = await tx
        .insert(orgRateLimitOverrides)
        .values(data)
        .onConflictDoUpdate({
          target: orgRateLimitOverrides.organization_id,
          set: {
            // Only update fields that were explicitly provided (including null to clear).
            // Undefined fields are omitted so existing values are preserved.
            ...("completions_rpm" in data && {
              completions_rpm: data.completions_rpm,
            }),
            ...("embeddings_rpm" in data && {
              embeddings_rpm: data.embeddings_rpm,
            }),
            ...("standard_rpm" in data && { standard_rpm: data.standard_rpm }),
            ...("strict_rpm" in data && { strict_rpm: data.strict_rpm }),
            ...("note" in data && { note: data.note }),
            updated_at: new Date(),
          },
        })
        .returning();
      const fields = [
        "completions_rpm",
        "embeddings_rpm",
        "standard_rpm",
        "strict_rpm",
        "note",
      ] as const;
      if (!before || fields.some((field) => before[field] !== result[field])) {
        await advanceOrganizationPolicyGeneration(tx, {
          organizationId: data.organization_id,
          reason: "rate_override_updated",
          actor,
          change: {
            completions_rpm: result.completions_rpm,
            embeddings_rpm: result.embeddings_rpm,
            standard_rpm: result.standard_rpm,
            strict_rpm: result.strict_rpm,
          },
        });
      }
      return result;
    });
  }

  async deleteByOrganizationId(organizationId: string, actor: string): Promise<void> {
    await writeTransaction(async (tx) => {
      await lockOrganizationPolicy(tx, organizationId);
      const removed = await tx
        .delete(orgRateLimitOverrides)
        .where(eq(orgRateLimitOverrides.organization_id, organizationId))
        .returning({ id: orgRateLimitOverrides.organization_id });
      if (removed.length > 0)
        await advanceOrganizationPolicyGeneration(tx, {
          organizationId,
          actor,
          reason: "rate_override_deleted",
          change: { deleted: true },
        });
    });
  }
}

export const orgRateLimitOverridesRepository = new OrgRateLimitOverridesRepository();
