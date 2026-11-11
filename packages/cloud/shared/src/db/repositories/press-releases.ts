// Persists press releases records for cloud services through the shared DB boundary.
import { ElizaError } from "@elizaos/core";
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

type RecordSubmissionResult =
  | { ok: true; release: PressRelease; distribution: PressReleaseDistribution }
  | { ok: false; error: string };

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
    database: Pick<typeof dbWrite, "update"> = dbWrite,
  ): Promise<PressRelease | undefined> {
    const [row] = await database
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

  async recordSubmission(
    data: Omit<NewPressReleaseDistribution, "status" | "submitted_at">,
  ): Promise<RecordSubmissionResult> {
    return dbWrite.transaction(async (tx) => {
      // Cancellation updates the same row. Use the locked primary state for
      // both admission and the receipt, including retries after a lost reply.
      const [release] = await tx
        .select()
        .from(pressReleases)
        .where(
          and(
            eq(pressReleases.id, data.press_release_id),
            eq(pressReleases.organization_id, data.organization_id),
          ),
        )
        .for("update")
        .limit(1);
      if (!release) return { ok: false, error: "Press release not found" };

      const maySubmit = release.status === "ready" || release.status === "submitted";
      const submittedAt = new Date();
      const [distribution] = maySubmit
        ? await tx
            .insert(pressReleaseDistributions)
            .values({ ...data, status: "submitted", submitted_at: submittedAt })
            .onConflictDoNothing({ target: pressReleaseDistributions.idempotency_key })
            .returning()
        : [];
      if (!distribution) {
        const key = data.idempotency_key ?? undefined;
        const mayReplay = ["submitted", "distributed", "failed"].includes(release.status);
        const existing =
          mayReplay && key !== undefined
            ? await tx.query.pressReleaseDistributions.findFirst({
                where: and(
                  eq(pressReleaseDistributions.idempotency_key, key),
                  eq(pressReleaseDistributions.press_release_id, release.id),
                  eq(pressReleaseDistributions.organization_id, release.organization_id),
                  eq(pressReleaseDistributions.provider, data.provider),
                ),
              })
            : undefined;
        if (existing) return { ok: true, release, distribution: existing };
        return {
          ok: false,
          error: maySubmit
            ? "Idempotency key already used"
            : "Press release is not ready for submission",
        };
      }

      if (release.status === "submitted") return { ok: true, release, distribution };
      const submitted = await this.transitionRelease(
        release.id,
        release.organization_id,
        "ready",
        "submitted",
        { submitted_at: submittedAt },
        tx,
      );
      if (!submitted) {
        throw new ElizaError("Submission could not be finalized", {
          code: "PRESS_RELEASE_SUBMISSION_UNAPPLIED",
          severity: "fatal",
        });
      }
      return { ok: true, release: submitted, distribution };
    });
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
