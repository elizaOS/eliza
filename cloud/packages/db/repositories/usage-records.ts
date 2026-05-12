import { and, desc, eq, gte, lte, type SQL, sql } from "drizzle-orm";
import { dbRead, dbWrite } from "../helpers";
import { organizations } from "../schemas/organizations";
import { type NewUsageRecord, type UsageRecord, usageRecords } from "../schemas/usage-records";
import { users } from "../schemas/users";

export type { NewUsageRecord, UsageRecord };

/**
 * Model/provider breakdowns use generated columns `canonical_model` and
 * `canonical_provider` on `usage_records`, aligned with
 * `canonicalUsageGroupingModel` / `normalizeProviderKey` in
 * `@/lib/providers/model-id-translation`.
 *
 * @see docs/openrouter-model-id-compatibility.md
 *
 * Time granularity for usage time series queries.
 */
export type TimeGranularity = "hour" | "day" | "week" | "month";

/**
 * Aggregated usage statistics.
 */
export interface UsageStats {
  totalRequests: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  successRate: number;
}

/**
 * Single data point in a usage time series.
 */
export interface TimeSeriesDataPoint {
  timestamp: Date;
  totalRequests: number;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  successRate: number;
}

/**
 * Usage breakdown by user.
 */
export interface UserUsageBreakdown {
  userId: string;
  userName: string | null;
  userEmail: string;
  totalRequests: number;
  totalCost: number;
  inputTokens: number;
  outputTokens: number;
  lastActive: Date | null;
}

/**
 * Cost trending analysis data.
 */
export interface CostTrending {
  currentDailyBurn: number;
  previousDailyBurn: number;
  burnChangePercent: number;
  projectedMonthlyBurn: number;
  daysUntilBalanceZero: number | null;
}

/**
 * Usage breakdown by provider.
 */
export interface ProviderBreakdown {
  provider: string;
  totalRequests: number;
  totalCost: number;
  totalTokens: number;
  successRate: number;
  percentage: number;
}

/**
 * Usage breakdown by model.
 */
export interface ModelBreakdown {
  model: string;
  provider: string;
  totalRequests: number;
  totalCost: number;
  totalTokens: number;
  avgCostPerToken: number;
  successRate: number;
}

/**
 * Trend comparison data between two periods.
 */
export interface TrendData {
  requestsChange: number;
  costChange: number;
  tokensChange: number;
  successRateChange: number;
  period: string;
}

/**
 * Cost breakdown item for a specific dimension (model, provider, user, etc.).
 */
export interface CostBreakdownItem {
  dimension: string;
  value: string;
  cost: number;
  requests: number;
  tokens: number;
  successCount: number;
  totalCount: number;
}

/**
 * Repository for usage record database operations and analytics.
 */
export class UsageRecordsRepository {
  // ============================================================================
  // READ OPERATIONS (use read-intent connection)
  // ============================================================================

  /**
   * Finds a usage record by ID.
   */
  async findById(id: string): Promise<UsageRecord | undefined> {
    return await dbRead.query.usageRecords.findFirst({
      where: eq(usageRecords.id, id),
    });
  }

  /**
   * Lists usage records for an organization, ordered by creation date.
   */
  async listByOrganization(organizationId: string, limit?: number): Promise<UsageRecord[]> {
    return await dbRead.query.usageRecords.findMany({
      where: eq(usageRecords.organization_id, organizationId),
      orderBy: desc(usageRecords.created_at),
      limit,
    });
  }

  /**
   * Lists usage records for an organization within a date range.
   */
  async listByOrganizationAndDateRange(
    organizationId: string,
    startDate: Date,
    endDate: Date,
  ): Promise<UsageRecord[]> {
    return await dbRead.query.usageRecords.findMany({
      where: and(
        eq(usageRecords.organization_id, organizationId),
        gte(usageRecords.created_at, startDate),
        lte(usageRecords.created_at, endDate),
      ),
      orderBy: desc(usageRecords.created_at),
    });
  }

  /**
   * Gets aggregated usage statistics for an organization within an optional date range.
   */
  async getStatsByOrganization(
    organizationId: string,
    startDate?: Date,
    endDate?: Date,
  ): Promise<UsageStats> {
    const conditions: SQL[] = [eq(usageRecords.organization_id, organizationId)];

    if (startDate) {
      conditions.push(sql`${usageRecords.created_at} >= ${startDate}`);
    }
    if (endDate) {
      conditions.push(sql`${usageRecords.created_at} <= ${endDate}`);
    }

    const [stats] = await dbRead
      .select({
        totalRequests: sql<number>`count(*)::int`,
        totalInputTokens: sql<number>`coalesce(sum(${usageRecords.input_tokens}), 0)::int`,
        totalOutputTokens: sql<number>`coalesce(sum(${usageRecords.output_tokens}), 0)::int`,
        totalCost: sql<number>`coalesce(sum(${usageRecords.input_cost} + ${usageRecords.output_cost}), 0)::numeric`,
        successRate: sql<number>`coalesce(
          count(*) filter (where ${usageRecords.is_successful} = true)::float /
          nullif(count(*)::float, 0),
          1.0
        )`,
      })
      .from(usageRecords)
      .where(and(...conditions));

    return {
      totalRequests: stats?.totalRequests || 0,
      totalInputTokens: stats?.totalInputTokens || 0,
      totalOutputTokens: stats?.totalOutputTokens || 0,
      totalCost: Number(stats?.totalCost || 0), // Convert NUMERIC to number
      successRate: stats?.successRate || 1.0,
    };
  }

  /**
   * Gets usage breakdown by model for an organization.
   */
  async getByModel(
    organizationId: string,
    startDate?: Date,
    endDate?: Date,
  ): Promise<
    Array<{
      model: string | null;
      provider: string | null;
      count: number;
      totalCost: number;
    }>
  > {
    const conditions = [eq(usageRecords.organization_id, organizationId)];

    if (startDate) {
      conditions.push(gte(usageRecords.created_at, startDate));
    }

    if (endDate) {
      conditions.push(lte(usageRecords.created_at, endDate));
    }

    const result = await dbRead
      .select({
        model: usageRecords.canonical_model,
        provider: usageRecords.canonical_provider,
        count: sql<number>`count(*)::int`,
        totalCost: sql<number>`sum(${usageRecords.input_cost} + ${usageRecords.output_cost})::numeric`,
      })
      .from(usageRecords)
      .where(and(...conditions))
      .groupBy(usageRecords.canonical_model, usageRecords.canonical_provider);

    return result
      .map((row) => ({
        model: row.model === "__null__" ? null : row.model,
        provider: row.provider,
        count: Number(row.count),
        totalCost: Number(row.totalCost || 0),
      }))
      .sort((a, b) => b.totalCost - a.totalCost);
  }

  /**
   * Gets usage time series data for an organization with specified granularity.
   */
  async getUsageTimeSeries(
    organizationId: string,
    options: {
      startDate: Date;
      endDate: Date;
      granularity: TimeGranularity;
    },
  ): Promise<TimeSeriesDataPoint[]> {
    const { startDate, endDate, granularity } = options;

    const truncateExpression = {
      hour: sql`date_trunc('hour', ${usageRecords.created_at})`,
      day: sql`date_trunc('day', ${usageRecords.created_at})`,
      week: sql`date_trunc('week', ${usageRecords.created_at})`,
      month: sql`date_trunc('month', ${usageRecords.created_at})`,
    }[granularity];

    const result = await dbRead
      .select({
        timestamp: truncateExpression.as("timestamp"),
        totalRequests: sql<number>`count(*)::int`,
        totalCost: sql<number>`coalesce(sum(${usageRecords.input_cost} + ${usageRecords.output_cost}), 0)::numeric`,
        inputTokens: sql<number>`coalesce(sum(${usageRecords.input_tokens}), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(${usageRecords.output_tokens}), 0)::int`,
        successRate: sql<number>`coalesce(
          count(*) filter (where ${usageRecords.is_successful} = true)::float /
          nullif(count(*)::float, 0),
          1.0
        )`,
      })
      .from(usageRecords)
      .where(
        and(
          eq(usageRecords.organization_id, organizationId),
          sql`${usageRecords.created_at} >= ${startDate}`,
          sql`${usageRecords.created_at} <= ${endDate}`,
        ),
      )
      .groupBy(truncateExpression)
      .orderBy(truncateExpression);

    return result.map((row) => ({
      timestamp: new Date(row.timestamp as string),
      totalRequests: row.totalRequests,
      totalCost: Number(row.totalCost || 0),
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      successRate: row.successRate,
    }));
  }

  /**
   * Gets usage breakdown by user for an organization.
   */
  async getUsageByUser(
    organizationId: string,
    options?: {
      startDate?: Date;
      endDate?: Date;
      limit?: number;
    },
  ): Promise<UserUsageBreakdown[]> {
    const { startDate, endDate, limit = 50 } = options || {};

    const conditions: SQL[] = [eq(usageRecords.organization_id, organizationId)];

    if (startDate) {
      conditions.push(sql`${usageRecords.created_at} >= ${startDate}`);
    }
    if (endDate) {
      conditions.push(sql`${usageRecords.created_at} <= ${endDate}`);
    }

    const result = await dbRead
      .select({
        userId: usageRecords.user_id,
        userName: users.name,
        userEmail: users.email,
        totalRequests: sql<number>`count(*)::int`,
        totalCost: sql<number>`coalesce(sum(${usageRecords.input_cost} + ${usageRecords.output_cost}), 0)::numeric`,
        inputTokens: sql<number>`coalesce(sum(${usageRecords.input_tokens}), 0)::int`,
        outputTokens: sql<number>`coalesce(sum(${usageRecords.output_tokens}), 0)::int`,
        lastActive: sql<Date>`max(${usageRecords.created_at})`,
      })
      .from(usageRecords)
      .leftJoin(users, eq(usageRecords.user_id, users.id))
      .where(and(...conditions))
      .groupBy(usageRecords.user_id, users.name, users.email)
      .orderBy(desc(sql`sum(${usageRecords.input_cost} + ${usageRecords.output_cost})`))
      .limit(limit);

    return result
      .filter((row) => row.userId !== null && row.userEmail !== null)
      .map((row) => ({
        userId: row.userId!,
        userName: row.userName,
        userEmail: row.userEmail!,
        totalRequests: row.totalRequests,
        totalCost: Number(row.totalCost || 0),
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        lastActive: row.lastActive,
      }));
  }

  /**
   * Gets cost trending analysis comparing current and previous day burn rates.
   */
  async getCostTrending(organizationId: string): Promise<CostTrending> {
    const now = new Date();
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const twoDaysAgo = new Date(now.getTime() - 48 * 60 * 60 * 1000);

    const [currentStats, previousStats, orgData] = await Promise.all([
      this.getStatsByOrganization(organizationId, yesterday, now),
      this.getStatsByOrganization(organizationId, twoDaysAgo, yesterday),
      dbRead.query.organizations.findFirst({
        where: eq(organizations.id, organizationId),
        columns: { credit_balance: true },
      }),
    ]);

    const currentDailyBurn = currentStats.totalCost;
    const previousDailyBurn = previousStats.totalCost;
    const burnChangePercent =
      previousDailyBurn > 0
        ? ((currentDailyBurn - previousDailyBurn) / previousDailyBurn) * 100
        : 0;

    const projectedMonthlyBurn = currentDailyBurn * 30;
    const creditBalance = orgData?.credit_balance || 0;
    const daysUntilBalanceZero =
      currentDailyBurn > 0 ? Math.floor(Number(creditBalance) / currentDailyBurn) : null;

    return {
      currentDailyBurn,
      previousDailyBurn,
      burnChangePercent,
      projectedMonthlyBurn,
      daysUntilBalanceZero,
    };
  }

  /**
   * Gets usage breakdown by provider for an organization.
   */
  async getProviderBreakdown(
    organizationId: string,
    options?: { startDate?: Date; endDate?: Date },
  ): Promise<ProviderBreakdown[]> {
    const conditions: SQL[] = [eq(usageRecords.organization_id, organizationId)];

    if (options?.startDate) {
      conditions.push(sql`${usageRecords.created_at} >= ${options.startDate}`);
    }
    if (options?.endDate) {
      conditions.push(sql`${usageRecords.created_at} <= ${options.endDate}`);
    }

    const result = await dbRead
      .select({
        provider: usageRecords.canonical_provider,
        totalRequests: sql<number>`count(*)::int`,
        totalCost: sql<number>`coalesce(sum(${usageRecords.input_cost} + ${usageRecords.output_cost}), 0)::numeric`,
        totalTokens: sql<number>`coalesce(sum(${usageRecords.input_tokens} + ${usageRecords.output_tokens}), 0)::int`,
        successRate: sql<number>`coalesce(
          count(*) filter (where ${usageRecords.is_successful} = true)::float /
          nullif(count(*)::float, 0),
          1.0
        )`,
      })
      .from(usageRecords)
      .where(and(...conditions))
      .groupBy(usageRecords.canonical_provider)
      .orderBy(desc(sql`sum(${usageRecords.input_cost} + ${usageRecords.output_cost})`));

    const aggregated = result.map((row) => ({
      provider: row.provider ?? "unknown",
      totalRequests: row.totalRequests,
      totalCost: Number(row.totalCost || 0),
      totalTokens: row.totalTokens,
      successRate: row.successRate,
    }));
    const totalCost = aggregated.reduce((sum, row) => sum + row.totalCost, 0);

    return aggregated.map((row) => ({
      ...row,
      percentage: totalCost > 0 ? (row.totalCost / totalCost) * 100 : 0,
    }));
  }

  /**
   * Gets usage breakdown by model for an organization.
   *
   * **Why SQL `GROUP BY` on normalized keys:** Ensures `LIMIT` applies after
   * `xai/…` and `x-ai/…` (and Mistral pairs) are merged so top models by cost are
   * correct. Display maps internal `__null__` to `"unknown"`.
   */
  async getModelBreakdown(
    organizationId: string,
    options?: { startDate?: Date; endDate?: Date; limit?: number },
  ): Promise<ModelBreakdown[]> {
    const { startDate, endDate, limit = 50 } = options || {};

    const conditions: SQL[] = [eq(usageRecords.organization_id, organizationId)];

    if (startDate) {
      conditions.push(sql`${usageRecords.created_at} >= ${startDate}`);
    }
    if (endDate) {
      conditions.push(sql`${usageRecords.created_at} <= ${endDate}`);
    }

    const result = await dbRead
      .select({
        groupModel: usageRecords.canonical_model,
        groupProvider: usageRecords.canonical_provider,
        totalRequests: sql<number>`count(*)::int`,
        totalCost: sql<number>`coalesce(sum(${usageRecords.input_cost} + ${usageRecords.output_cost}), 0)::numeric`,
        totalTokens: sql<number>`coalesce(sum(${usageRecords.input_tokens} + ${usageRecords.output_tokens}), 0)::int`,
        successRate: sql<number>`coalesce(
          count(*) filter (where ${usageRecords.is_successful} = true)::float /
          nullif(count(*)::float, 0),
          1.0
        )`,
      })
      .from(usageRecords)
      .where(and(...conditions))
      .groupBy(usageRecords.canonical_model, usageRecords.canonical_provider)
      .orderBy(desc(sql`sum(${usageRecords.input_cost} + ${usageRecords.output_cost})`))
      .limit(limit);

    return result.map((row): ModelBreakdown => {
      const groupModel = String(row.groupModel);
      const displayModel = groupModel === "__null__" ? "unknown" : groupModel;
      const totalCost = Number(row.totalCost || 0);
      const totalTokens = row.totalTokens;
      return {
        model: displayModel,
        provider: String(row.groupProvider),
        totalRequests: row.totalRequests,
        totalCost,
        totalTokens,
        avgCostPerToken: totalTokens > 0 ? totalCost / totalTokens : 0,
        successRate: row.successRate,
      };
    });
  }

  /**
   * Gets trend comparison data between two time periods.
   */
  async getTrendData(
    organizationId: string,
    currentPeriod: { startDate: Date; endDate: Date },
    previousPeriod: { startDate: Date; endDate: Date },
  ): Promise<TrendData> {
    const [currentStats, previousStats] = await Promise.all([
      this.getStatsByOrganization(organizationId, currentPeriod.startDate, currentPeriod.endDate),
      this.getStatsByOrganization(organizationId, previousPeriod.startDate, previousPeriod.endDate),
    ]);

    const calculateChange = (current: number, previous: number): number => {
      if (previous === 0) return current > 0 ? 100 : 0;
      return ((current - previous) / previous) * 100;
    };

    const periodDays = Math.ceil(
      (currentPeriod.endDate.getTime() - currentPeriod.startDate.getTime()) / (1000 * 60 * 60 * 24),
    );

    return {
      requestsChange: calculateChange(currentStats.totalRequests, previousStats.totalRequests),
      costChange: calculateChange(Number(currentStats.totalCost), Number(previousStats.totalCost)),
      tokensChange: calculateChange(
        currentStats.totalInputTokens + currentStats.totalOutputTokens,
        previousStats.totalInputTokens + previousStats.totalOutputTokens,
      ),
      successRateChange: calculateChange(currentStats.successRate, previousStats.successRate),
      period: `${periodDays}d`,
    };
  }

  /**
   * Gets cost breakdown by dimension (model, provider, user, or API key).
   *
   * **Model / provider dimensions:** Groups on the same normalized keys as
   * `getModelBreakdown` / `getProviderBreakdown` so cost explorer views do not
   * split xAI or Mistral across two rows after the OpenRouter migration.
   * **User / API key:** Still grouped on raw columns (UUIDs); null becomes
   * `"unknown"` in the mapped output.
   */
  async getCostBreakdown(
    organizationId: string,
    dimension: "model" | "provider" | "user" | "apiKey",
    options?: {
      startDate?: Date;
      endDate?: Date;
      sortBy?: "cost" | "requests" | "tokens";
      sortOrder?: "asc" | "desc";
      limit?: number;
      offset?: number;
    },
  ): Promise<CostBreakdownItem[]> {
    const {
      startDate,
      endDate,
      sortBy = "cost",
      sortOrder = "desc",
      limit = 100,
      offset = 0,
    } = options || {};

    const conditions: SQL[] = [eq(usageRecords.organization_id, organizationId)];

    if (startDate) {
      conditions.push(sql`${usageRecords.created_at} >= ${startDate}`);
    }
    if (endDate) {
      conditions.push(sql`${usageRecords.created_at} <= ${endDate}`);
    }

    const sortColumn = {
      cost: sql`sum(${usageRecords.input_cost} + ${usageRecords.output_cost})`,
      requests: sql`count(*)`,
      tokens: sql`sum(${usageRecords.input_tokens} + ${usageRecords.output_tokens})`,
    }[sortBy];

    const orderDirection = sortOrder === "desc" ? desc(sortColumn) : sortColumn;

    const mapCostRow = (row: {
      value: string | null;
      cost: number;
      requests: number;
      tokens: number;
      successCount: number;
      totalCount: number;
    }): CostBreakdownItem => ({
      dimension,
      value: row.value || "unknown",
      cost: Number(row.cost || 0),
      requests: row.requests,
      tokens: row.tokens,
      successCount: row.successCount,
      totalCount: row.totalCount,
    });

    if (dimension === "model") {
      const result = await dbRead
        .select({
          value: usageRecords.canonical_model,
          cost: sql<number>`coalesce(sum(${usageRecords.input_cost} + ${usageRecords.output_cost}), 0)::numeric`,
          requests: sql<number>`count(*)::int`,
          tokens: sql<number>`coalesce(sum(${usageRecords.input_tokens} + ${usageRecords.output_tokens}), 0)::int`,
          successCount: sql<number>`count(*) filter (where ${usageRecords.is_successful} = true)::int`,
          totalCount: sql<number>`count(*)::int`,
        })
        .from(usageRecords)
        .where(and(...conditions))
        .groupBy(usageRecords.canonical_model)
        .orderBy(orderDirection)
        .limit(limit)
        .offset(offset);

      return result.map((row) =>
        mapCostRow({
          ...row,
          value: String(row.value) === "__null__" ? "unknown" : String(row.value),
        }),
      );
    }

    if (dimension === "provider") {
      const result = await dbRead
        .select({
          value: usageRecords.canonical_provider,
          cost: sql<number>`coalesce(sum(${usageRecords.input_cost} + ${usageRecords.output_cost}), 0)::numeric`,
          requests: sql<number>`count(*)::int`,
          tokens: sql<number>`coalesce(sum(${usageRecords.input_tokens} + ${usageRecords.output_tokens}), 0)::int`,
          successCount: sql<number>`count(*) filter (where ${usageRecords.is_successful} = true)::int`,
          totalCount: sql<number>`count(*)::int`,
        })
        .from(usageRecords)
        .where(and(...conditions))
        .groupBy(usageRecords.canonical_provider)
        .orderBy(orderDirection)
        .limit(limit)
        .offset(offset);

      return result.map((row) => mapCostRow({ ...row, value: String(row.value) }));
    }

    const dimensionColumn = dimension === "user" ? usageRecords.user_id : usageRecords.api_key_id;

    const result = await dbRead
      .select({
        value: dimensionColumn,
        cost: sql<number>`coalesce(sum(${usageRecords.input_cost} + ${usageRecords.output_cost}), 0)::numeric`,
        requests: sql<number>`count(*)::int`,
        tokens: sql<number>`coalesce(sum(${usageRecords.input_tokens} + ${usageRecords.output_tokens}), 0)::int`,
        successCount: sql<number>`count(*) filter (where ${usageRecords.is_successful} = true)::int`,
        totalCount: sql<number>`count(*)::int`,
      })
      .from(usageRecords)
      .where(and(...conditions))
      .groupBy(dimensionColumn)
      .orderBy(orderDirection)
      .limit(limit)
      .offset(offset);

    return result.map((row) =>
      mapCostRow({
        ...row,
        value: row.value == null ? null : String(row.value),
      }),
    );
  }

  // ============================================================================
  // WRITE OPERATIONS (use primary)
  // ============================================================================

  /**
   * Creates a new usage record.
   */
  async create(data: NewUsageRecord): Promise<UsageRecord> {
    const [record] = await dbWrite.insert(usageRecords).values(data).returning();
    return record;
  }

  /**
   * Updates a usage record by ID.
   */
  async update(
    id: string,
    data: Partial<
      Pick<UsageRecord, "is_successful" | "error_message" | "duration_ms" | "metadata">
    >,
  ): Promise<UsageRecord | undefined> {
    const [record] = await dbWrite
      .update(usageRecords)
      .set(data)
      .where(eq(usageRecords.id, id))
      .returning();
    return record;
  }

  /**
   * Marks a deployment usage record as failed.
   * Finds the most recent deployment record for the container and updates it.
   */
  async markDeploymentFailed(
    containerId: string,
    organizationId: string,
    errorMessage: string,
  ): Promise<UsageRecord | undefined> {
    // Find the most recent deployment record for this container
    const records = await dbRead
      .select()
      .from(usageRecords)
      .where(
        and(
          eq(usageRecords.organization_id, organizationId),
          sql`${usageRecords.type} IN ('container_deployment', 'container_update')`,
          sql`${usageRecords.metadata}->>'container_id' = ${containerId}`,
        ),
      )
      .orderBy(desc(usageRecords.created_at))
      .limit(1);

    if (records.length === 0) {
      return undefined;
    }

    const record = records[0];

    // Update the record to mark as failed
    const [updated] = await dbWrite
      .update(usageRecords)
      .set({
        is_successful: false,
        error_message: errorMessage,
      })
      .where(eq(usageRecords.id, record.id))
      .returning();

    return updated;
  }

  /**
   * Marks a deployment usage record as successful.
   * Finds the most recent deployment record for the container and updates it.
   */
  async markDeploymentSuccessful(
    containerId: string,
    organizationId: string,
    durationMs?: number,
  ): Promise<UsageRecord | undefined> {
    // Find the most recent deployment record for this container
    const records = await dbRead
      .select()
      .from(usageRecords)
      .where(
        and(
          eq(usageRecords.organization_id, organizationId),
          sql`${usageRecords.type} IN ('container_deployment', 'container_update')`,
          sql`${usageRecords.metadata}->>'container_id' = ${containerId}`,
        ),
      )
      .orderBy(desc(usageRecords.created_at))
      .limit(1);

    if (records.length === 0) {
      return undefined;
    }

    const record = records[0];

    // Update the record to mark as successful
    const [updated] = await dbWrite
      .update(usageRecords)
      .set({
        is_successful: true,
        duration_ms: durationMs,
      })
      .where(eq(usageRecords.id, record.id))
      .returning();

    return updated;
  }
}

/**
 * Singleton instance of UsageRecordsRepository.
 */
export const usageRecordsRepository = new UsageRecordsRepository();
