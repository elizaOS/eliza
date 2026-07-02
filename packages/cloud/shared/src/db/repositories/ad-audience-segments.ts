import { and, desc, eq } from "drizzle-orm";
import { db } from "../client";
import {
  type AdAudienceSegment,
  adAudienceSegments,
  type NewAdAudienceSegment,
} from "../schemas/ad-audience-segments";

export type { AdAudienceSegment, NewAdAudienceSegment };

export class AdAudienceSegmentsRepository {
  async findById(id: string): Promise<AdAudienceSegment | undefined> {
    return await db.query.adAudienceSegments.findFirst({
      where: eq(adAudienceSegments.id, id),
    });
  }

  async listByOrganization(organizationId: string): Promise<AdAudienceSegment[]> {
    return await db.query.adAudienceSegments.findMany({
      where: eq(adAudienceSegments.organization_id, organizationId),
      orderBy: desc(adAudienceSegments.created_at),
    });
  }

  async create(data: NewAdAudienceSegment): Promise<AdAudienceSegment> {
    const [segment] = await db.insert(adAudienceSegments).values(data).returning();
    return segment;
  }

  async update(
    id: string,
    organizationId: string,
    data: Partial<NewAdAudienceSegment>,
  ): Promise<AdAudienceSegment | undefined> {
    const [updated] = await db
      .update(adAudienceSegments)
      .set({ ...data, updated_at: new Date() })
      .where(
        and(eq(adAudienceSegments.id, id), eq(adAudienceSegments.organization_id, organizationId)),
      )
      .returning();
    return updated;
  }

  async delete(id: string, organizationId: string): Promise<void> {
    await db
      .delete(adAudienceSegments)
      .where(
        and(eq(adAudienceSegments.id, id), eq(adAudienceSegments.organization_id, organizationId)),
      );
  }
}

export const adAudienceSegmentsRepository = new AdAudienceSegmentsRepository();
