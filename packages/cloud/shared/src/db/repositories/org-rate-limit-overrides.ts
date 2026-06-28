import { eq } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import {
  type NewOrgRateLimitOverride,
  type OrgRateLimitOverride,
  orgRateLimitOverrides,
} from "../schemas/org-rate-limit-overrides";

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
  ): Promise<OrgRateLimitOverride> {
    const [result] = await dbWrite
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
    return result;
  }

  async deleteByOrganizationId(organizationId: string): Promise<void> {
    await dbWrite
      .delete(orgRateLimitOverrides)
      .where(eq(orgRateLimitOverrides.organization_id, organizationId));
  }
}

export const orgRateLimitOverridesRepository = new OrgRateLimitOverridesRepository();
