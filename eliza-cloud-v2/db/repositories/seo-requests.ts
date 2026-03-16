import { and, desc, eq } from "drizzle-orm";
import { db } from "../client";
import {
  seoRequests,
  type SeoRequest,
  type NewSeoRequest,
  seoRequestStatusEnum,
} from "../schemas/seo";

export type { SeoRequest, NewSeoRequest };

export class SeoRequestsRepository {
  async findById(id: string): Promise<SeoRequest | undefined> {
    return await db.query.seoRequests.findFirst({
      where: eq(seoRequests.id, id),
    });
  }

  async findByIdempotency(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<SeoRequest | undefined> {
    return await db.query.seoRequests.findFirst({
      where: and(
        eq(seoRequests.organization_id, organizationId),
        eq(seoRequests.idempotency_key, idempotencyKey),
      ),
    });
  }

  async listByOrganization(
    organizationId: string,
    options?: {
      limit?: number;
      status?: (typeof seoRequestStatusEnum.enumValues)[number];
    },
  ): Promise<SeoRequest[]> {
    const conditions = [eq(seoRequests.organization_id, organizationId)];
    if (options?.status) {
      conditions.push(eq(seoRequests.status, options.status));
    }

    return await db.query.seoRequests.findMany({
      where: conditions.length > 1 ? and(...conditions) : conditions[0],
      orderBy: desc(seoRequests.created_at),
      limit: options?.limit,
    });
  }

  async create(data: NewSeoRequest): Promise<SeoRequest> {
    const [request] = await db.insert(seoRequests).values(data).returning();
    return request;
  }

  async updateStatus(
    id: string,
    status: (typeof seoRequestStatusEnum.enumValues)[number],
    extras?: Partial<NewSeoRequest>,
  ): Promise<SeoRequest | undefined> {
    const [updated] = await db
      .update(seoRequests)
      .set({
        ...extras,
        status,
        updated_at: new Date(),
        ...(status === "completed" ? { completed_at: new Date() } : undefined),
      })
      .where(eq(seoRequests.id, id))
      .returning();
    return updated;
  }
}

export const seoRequestsRepository = new SeoRequestsRepository();
