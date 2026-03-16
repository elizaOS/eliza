import { desc, eq } from "drizzle-orm";
import { db } from "../client";
import {
  seoProviderCalls,
  type SeoProviderCall,
  type NewSeoProviderCall,
} from "../schemas/seo";

export type { SeoProviderCall, NewSeoProviderCall };

export class SeoProviderCallsRepository {
  async listByRequest(requestId: string): Promise<SeoProviderCall[]> {
    return await db.query.seoProviderCalls.findMany({
      where: eq(seoProviderCalls.request_id, requestId),
      orderBy: desc(seoProviderCalls.created_at),
    });
  }

  async create(data: NewSeoProviderCall): Promise<SeoProviderCall> {
    const [call] = await db.insert(seoProviderCalls).values(data).returning();
    return call;
  }

  async updateStatus(
    id: string,
    status: SeoProviderCall["status"],
    extras?: Partial<NewSeoProviderCall>,
  ): Promise<SeoProviderCall | undefined> {
    const [updated] = await db
      .update(seoProviderCalls)
      .set({
        ...extras,
        status,
        completed_at: new Date(),
      })
      .where(eq(seoProviderCalls.id, id))
      .returning();
    return updated;
  }
}

export const seoProviderCallsRepository = new SeoProviderCallsRepository();
