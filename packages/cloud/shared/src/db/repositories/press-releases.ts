import { and, desc, eq } from "drizzle-orm";
import { dbRead, dbWrite } from "../client";
import {
  type NewPressCoverage,
  type NewPressMediaContact,
  type NewPressRelease,
  type NewPressReleaseDistribution,
  type PressCoverage,
  type PressDistributionStatus,
  type PressMediaContact,
  type PressRelease,
  type PressReleaseAsset,
  type PressReleaseDistribution,
  type PressReleaseStatus,
  type PressReleaseTargetAudience,
  pressCoverage,
  pressMediaContacts,
  pressReleaseDistributions,
  pressReleases,
} from "../schemas/press-releases";

export type {
  NewPressCoverage,
  NewPressMediaContact,
  NewPressRelease,
  NewPressReleaseDistribution,
  PressCoverage,
  PressMediaContact,
  PressRelease,
  PressReleaseAsset,
  PressReleaseDistribution,
  PressReleaseTargetAudience,
};

export class PressReleasesRepository {
  findReleaseById(id: string): Promise<PressRelease | undefined> {
    return dbRead.query.pressReleases.findFirst({ where: eq(pressReleases.id, id) });
  }

  findReleaseByIdForOrg(id: string, organizationId: string): Promise<PressRelease | undefined> {
    return dbRead.query.pressReleases.findFirst({
      where: and(eq(pressReleases.id, id), eq(pressReleases.organization_id, organizationId)),
    });
  }

  findReleaseByIdempotencyKey(key: string): Promise<PressRelease | undefined> {
    return dbRead.query.pressReleases.findFirst({
      where: eq(pressReleases.idempotency_key, key),
    });
  }

  listReleasesForOrg(organizationId: string, limit = 100): Promise<PressRelease[]> {
    return dbRead.query.pressReleases.findMany({
      where: eq(pressReleases.organization_id, organizationId),
      orderBy: [desc(pressReleases.created_at)],
      limit,
    });
  }

  async createRelease(data: NewPressRelease): Promise<PressRelease> {
    const [row] = await dbWrite.insert(pressReleases).values(data).returning();
    return row;
  }

  async updateReleaseDraft(
    id: string,
    organizationId: string,
    data: Partial<NewPressRelease>,
  ): Promise<PressRelease | undefined> {
    const [row] = await dbWrite
      .update(pressReleases)
      .set({ ...data, updated_at: new Date() })
      .where(
        and(
          eq(pressReleases.id, id),
          eq(pressReleases.organization_id, organizationId),
          eq(pressReleases.status, "draft"),
        ),
      )
      .returning();
    return row;
  }

  async transitionRelease(
    id: string,
    organizationId: string,
    from: PressReleaseStatus,
    to: PressReleaseStatus,
    extra: Partial<NewPressRelease> = {},
  ): Promise<PressRelease | undefined> {
    const [row] = await dbWrite
      .update(pressReleases)
      .set({ ...extra, status: to, updated_at: new Date() })
      .where(
        and(
          eq(pressReleases.id, id),
          eq(pressReleases.organization_id, organizationId),
          eq(pressReleases.status, from),
        ),
      )
      .returning();
    return row;
  }

  findDistributionById(id: string): Promise<PressReleaseDistribution | undefined> {
    return dbRead.query.pressReleaseDistributions.findFirst({
      where: eq(pressReleaseDistributions.id, id),
    });
  }

  findDistributionByIdempotencyKey(key: string): Promise<PressReleaseDistribution | undefined> {
    return dbRead.query.pressReleaseDistributions.findFirst({
      where: eq(pressReleaseDistributions.idempotency_key, key),
    });
  }

  listDistributionsForRelease(
    pressReleaseId: string,
    organizationId: string,
  ): Promise<PressReleaseDistribution[]> {
    return dbRead.query.pressReleaseDistributions.findMany({
      where: and(
        eq(pressReleaseDistributions.press_release_id, pressReleaseId),
        eq(pressReleaseDistributions.organization_id, organizationId),
      ),
      orderBy: [desc(pressReleaseDistributions.created_at)],
    });
  }

  async createDistribution(data: NewPressReleaseDistribution): Promise<PressReleaseDistribution> {
    const [row] = await dbWrite.insert(pressReleaseDistributions).values(data).returning();
    return row;
  }

  async transitionDistribution(
    id: string,
    from: PressDistributionStatus,
    to: PressDistributionStatus,
    extra: Partial<NewPressReleaseDistribution> = {},
  ): Promise<PressReleaseDistribution | undefined> {
    const [row] = await dbWrite
      .update(pressReleaseDistributions)
      .set({ ...extra, status: to, updated_at: new Date() })
      .where(and(eq(pressReleaseDistributions.id, id), eq(pressReleaseDistributions.status, from)))
      .returning();
    return row;
  }

  async createContact(data: NewPressMediaContact): Promise<PressMediaContact> {
    const [row] = await dbWrite.insert(pressMediaContacts).values(data).returning();
    return row;
  }

  listContactsForOrg(organizationId: string): Promise<PressMediaContact[]> {
    return dbRead.query.pressMediaContacts.findMany({
      where: eq(pressMediaContacts.organization_id, organizationId),
      orderBy: [desc(pressMediaContacts.created_at)],
    });
  }

  async recordCoverage(data: NewPressCoverage): Promise<PressCoverage> {
    const [row] = await dbWrite
      .insert(pressCoverage)
      .values(data)
      .onConflictDoUpdate({
        target: [pressCoverage.press_release_id, pressCoverage.url],
        set: {
          title: data.title,
          outlet: data.outlet,
          published_at: data.published_at,
          metadata: data.metadata,
        },
      })
      .returning();
    return row;
  }

  listCoverageForRelease(pressReleaseId: string, organizationId: string): Promise<PressCoverage[]> {
    return dbRead.query.pressCoverage.findMany({
      where: and(
        eq(pressCoverage.press_release_id, pressReleaseId),
        eq(pressCoverage.organization_id, organizationId),
      ),
      orderBy: [desc(pressCoverage.created_at)],
    });
  }
}

export const pressReleasesRepository = new PressReleasesRepository();
