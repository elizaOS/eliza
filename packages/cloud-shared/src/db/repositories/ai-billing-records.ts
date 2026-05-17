import { and, desc, eq, gte, lte } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import {
  type AiBillingRecord,
  aiBillingRecords,
  type NewAiBillingRecord,
} from "../schemas/ai-billing-records";

export type { AiBillingRecord, NewAiBillingRecord };

export class AiBillingRecordsRepository {
  async createDeduped(data: NewAiBillingRecord): Promise<AiBillingRecord> {
    const [created] = await dbWrite
      .insert(aiBillingRecords)
      .values(data)
      .onConflictDoNothing({
        target: [aiBillingRecords.organization_id, aiBillingRecords.idempotency_key],
      })
      .returning();

    if (created) return created;

    const existing = await this.findByOrganizationAndIdempotencyKey(
      data.organization_id,
      data.idempotency_key,
    );
    if (!existing) {
      throw new Error("[AiBillingRecordsRepository] idempotency conflict did not return a row");
    }
    return existing;
  }

  async findByOrganizationAndIdempotencyKey(
    organizationId: string,
    idempotencyKey: string,
  ): Promise<AiBillingRecord | undefined> {
    return await dbRead.query.aiBillingRecords.findFirst({
      where: and(
        eq(aiBillingRecords.organization_id, organizationId),
        eq(aiBillingRecords.idempotency_key, idempotencyKey),
      ),
    });
  }

  async listForReconciliation(filters: {
    organizationId?: string;
    provider?: string;
    model?: string;
    startDate: Date;
    endDate: Date;
    limit?: number;
  }): Promise<AiBillingRecord[]> {
    const conditions = [
      gte(aiBillingRecords.created_at, filters.startDate),
      lte(aiBillingRecords.created_at, filters.endDate),
    ];
    if (filters.organizationId) {
      conditions.push(eq(aiBillingRecords.organization_id, filters.organizationId));
    }
    if (filters.provider) {
      conditions.push(eq(aiBillingRecords.provider, filters.provider));
    }
    if (filters.model) {
      conditions.push(eq(aiBillingRecords.model, filters.model));
    }

    return await dbRead.query.aiBillingRecords.findMany({
      where: and(...conditions),
      orderBy: desc(aiBillingRecords.created_at),
      limit: Math.min(Math.max(filters.limit ?? 1000, 1), 10_000),
    });
  }
}

export const aiBillingRecordsRepository = new AiBillingRecordsRepository();
