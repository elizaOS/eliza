import { and, desc, eq, getTableColumns, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import {
  type NewServicePricing,
  type NewServicePricingAudit,
  type ServicePricing,
  type ServicePricingAudit,
  servicePricing,
  servicePricingAudit,
} from "../schemas/service-pricing";

export type { NewServicePricing, NewServicePricingAudit, ServicePricing, ServicePricingAudit };

type PricingMetadata = NewServicePricing["metadata"];

function normalizeMetadata(metadata?: Record<string, unknown>): PricingMetadata {
  if (!metadata) {
    return {};
  }

  const normalized: NonNullable<PricingMetadata> = {};

  for (const [key, value] of Object.entries(metadata)) {
    if (
      value === null ||
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      normalized[key] = value;
      continue;
    }

    throw new Error(`Metadata value for key '${key}' must be a string, number, boolean, or null`);
  }

  return normalized;
}

export class ServicePricingRepository {
  async findByServiceAndMethod(
    serviceId: string,
    method: string,
  ): Promise<ServicePricing | undefined> {
    return await dbRead.query.servicePricing.findFirst({
      where: and(
        eq(servicePricing.service_id, serviceId),
        eq(servicePricing.method, method),
        eq(servicePricing.is_active, true),
      ),
    });
  }

  /**
   * Lists all pricing records for a service
   *
   * @param serviceId - Service identifier (e.g., "solana-rpc")
   * @param activeOnly - If true, only return active methods (default: true)
   * @returns Array of service pricing records
   */
  async listByService(serviceId: string, activeOnly: boolean = true): Promise<ServicePricing[]> {
    const conditions = [eq(servicePricing.service_id, serviceId)];

    if (activeOnly) {
      conditions.push(eq(servicePricing.is_active, true));
    }

    return await dbRead.query.servicePricing.findMany({
      where: and(...conditions),
    });
  }

  async upsert(
    serviceId: string,
    method: string,
    cost: number,
    userId: string,
    reason?: string,
    description?: string,
    metadata?: Record<string, unknown>,
    ipAddress?: string,
    userAgent?: string,
  ): Promise<ServicePricing> {
    // Validate metadata constraints at runtime
    if (metadata) {
      const keys = Object.keys(metadata);
      if (keys.length > 20) {
        throw new Error("Metadata cannot have more than 20 keys");
      }
      for (const key of keys) {
        if (key.length > 100) {
          throw new Error(`Metadata key exceeds 100 character limit: ${key.substring(0, 20)}...`);
        }
        const val = metadata[key];
        if (typeof val === "string" && val.length > 1000) {
          throw new Error(`Metadata value for key '${key}' exceeds 1000 character limit`);
        }
      }
    }

    // Race-condition safe: Postgres INSERT ... ON CONFLICT DO UPDATE is atomic
    // under concurrent access. No application-level retry needed.
    return await dbWrite.transaction(async (tx) => {
      const costStr = cost.toString();
      const normalizedMetadata = normalizeMetadata(metadata);

      // Atomic upsert with conflict detection via xmax and old cost via subquery.
      // xmax=0 means INSERT (new row), xmax!=0 means UPDATE (conflict resolved).
      // The subquery fetches the previous cost from the audit trail in the same statement.
      // Atomic upsert - INSERT ... ON CONFLICT DO UPDATE is race-condition safe in Postgres
      const [row] = await tx
        .insert(servicePricing)
        .values({
          service_id: serviceId,
          method,
          cost: costStr,
          description: description ?? null,
          metadata: normalizedMetadata,
          updated_by: userId,
        })
        .onConflictDoUpdate({
          target: [servicePricing.service_id, servicePricing.method],
          set: {
            cost: costStr,
            description: sql`coalesce(${sql.param(description ?? null)}, ${servicePricing.description})`,
            metadata: sql`coalesce(${sql.param(metadata ? normalizedMetadata : null)}::jsonb, ${servicePricing.metadata})`,
            updated_by: userId,
            updated_at: new Date(),
          },
        })
        .returning({
          ...getTableColumns(servicePricing),
          wasUpdate: sql<boolean>`xmax::text::int > 0`,
          previousCost: sql<string | null>`(
            SELECT new_cost FROM service_pricing_audit
            WHERE service_pricing_id = ${servicePricing.id}
            ORDER BY created_at DESC LIMIT 1
          )`,
        });

      const { wasUpdate, previousCost, ...result } = row;

      await tx.insert(servicePricingAudit).values({
        service_pricing_id: result.id,
        service_id: serviceId,
        method,
        old_cost: wasUpdate ? previousCost : null,
        new_cost: costStr,
        change_type: wasUpdate ? "update" : "create",
        changed_by: userId,
        reason: reason ?? null,
        ip_address: ipAddress ?? null,
        user_agent: userAgent ?? null,
      });

      return result;
    });
  }

  /**
   * List audit history for a service.
   * Uses the read-intent connection for audit queries.
   */
  async listAuditHistory(
    serviceId: string,
    limit: number = 50,
    offset: number = 0,
  ): Promise<ServicePricingAudit[]> {
    return await dbRead.query.servicePricingAudit.findMany({
      where: eq(servicePricingAudit.service_id, serviceId),
      orderBy: [desc(servicePricingAudit.created_at)],
      limit,
      offset,
    });
  }
}

export const servicePricingRepository = new ServicePricingRepository();
