// Persists user mcps records for cloud services through the shared DB boundary.
import { ElizaError } from "@elizaos/core";
import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { mutateRowCount } from "../execute-helpers";
import { dbRead, dbWrite } from "../helpers";
import {
  type McpUsage,
  mcpUsage,
  type NewMcpUsage,
  type NewUserMcp,
  type UserMcp,
  userMcps,
} from "../schemas";
import { escapeLikePattern } from "../utils/like-pattern";
import { parseUsageMoneyAggregate } from "./usage-money";

function parseUsageAggregate(value: unknown, field: string): number {
  const parsed = Number(value ?? 0);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new ElizaError("Stored MCP usage aggregate is corrupt.", {
      code: "CORRUPT_MCP_USAGE_RECEIPT",
      context: { field, value },
      severity: "fatal",
    });
  }
  return parsed;
}

/**
 * User MCPs Repository
 *
 * CRUD operations for user-created MCP servers.
 */
export const userMcpsRepository = {
  // ============================================================================
  // READ OPERATIONS (use read-intent connection)
  // ============================================================================

  /**
   * Get MCP by ID
   */
  async getById(id: string): Promise<UserMcp | null> {
    const [mcp] = await dbRead.select().from(userMcps).where(eq(userMcps.id, id));
    return mcp ?? null;
  },

  /**
   * Get MCP by slug and organization
   */
  async getBySlug(slug: string, organizationId: string): Promise<UserMcp | null> {
    const [mcp] = await dbRead
      .select()
      .from(userMcps)
      .where(and(eq(userMcps.slug, slug), eq(userMcps.organization_id, organizationId)));
    return mcp ?? null;
  },

  /**
   * List MCPs by organization
   */
  async listByOrganization(
    organizationId: string,
    options: {
      status?: UserMcp["status"];
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<UserMcp[]> {
    const { status } = options;
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);

    let query = dbRead
      .select()
      .from(userMcps)
      .where(eq(userMcps.organization_id, organizationId))
      .orderBy(desc(userMcps.created_at))
      .limit(limit)
      .offset(offset);

    if (status) {
      query = dbRead
        .select()
        .from(userMcps)
        .where(and(eq(userMcps.organization_id, organizationId), eq(userMcps.status, status)))
        .orderBy(desc(userMcps.created_at))
        .limit(limit)
        .offset(offset);
    }

    return query;
  },

  /**
   * List public MCPs (for registry)
   */
  async listPublic(
    options: {
      category?: string;
      status?: UserMcp["status"];
      search?: string;
      limit?: number;
      offset?: number;
      orderBy?: "name";
    } = {},
  ): Promise<UserMcp[]> {
    const { category, status = "live", search } = options;
    const limit = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const offset = Math.max(options.offset ?? 0, 0);

    const conditions = [eq(userMcps.is_public, true), eq(userMcps.status, status)];

    if (category) {
      conditions.push(eq(userMcps.category, category));
    }

    if (search) {
      conditions.push(
        or(
          ilike(userMcps.name, `%${escapeLikePattern(search)}%`),
          ilike(userMcps.description, `%${escapeLikePattern(search)}%`),
        )!,
      );
    }

    return (
      dbRead
        .select()
        .from(userMcps)
        .where(and(...conditions))
        // orderBy "name" uses COLLATE "C" so windows fetched here can be merged
        // with plain code-unit comparison by callers paginating across sources
        // (discovery, #19076/#19083); see characters.listPublic for the contract.
        .orderBy(
          ...(options.orderBy === "name"
            ? [sql`${userMcps.name} COLLATE "C" asc`, sql`${userMcps.id} asc`]
            : [desc(userMcps.total_requests), desc(userMcps.created_at)]),
        )
        .limit(limit)
        .offset(offset)
    );
  },

  /**
   * Counts public MCPs under the same conditions as listPublic, so paginating
   * callers can report exact totals without scanning (#19083). Counts DISTINCT
   * discovery identities, not raw rows: the slug is unique only per
   * organization, so two organizations exposing the same slug+name+description
   * collapse to one visible catalog entry downstream (discovery's
   * getDiscoveryKey), and a raw COUNT would advertise rows the response can
   * never show.
   */
  async countPublic(
    options: { category?: string; status?: UserMcp["status"]; search?: string } = {},
  ): Promise<number> {
    const { category, status = "live", search } = options;
    const conditions = [eq(userMcps.is_public, true), eq(userMcps.status, status)];
    if (category) {
      conditions.push(eq(userMcps.category, category));
    }
    if (search) {
      conditions.push(
        or(
          ilike(userMcps.name, `%${escapeLikePattern(search)}%`),
          ilike(userMcps.description, `%${escapeLikePattern(search)}%`),
        )!,
      );
    }
    const [result] = await dbRead
      .select({
        count: sql<number>`count(distinct (${userMcps.slug}, lower(trim(${userMcps.name})), lower(trim(${userMcps.description}))))`,
      })
      .from(userMcps)
      .where(and(...conditions));
    return Number(result?.count ?? 0);
  },

  /**
   * Get MCPs by container ID
   */
  async getByContainerId(containerId: string): Promise<UserMcp[]> {
    return dbRead.select().from(userMcps).where(eq(userMcps.container_id, containerId));
  },

  /**
   * Count MCPs by organization
   */
  async countByOrganization(organizationId: string): Promise<number> {
    const [result] = await dbRead
      .select({ count: sql<number>`count(*)` })
      .from(userMcps)
      .where(eq(userMcps.organization_id, organizationId));
    return Number(result?.count ?? 0);
  },

  // ============================================================================
  // WRITE OPERATIONS (use primary)
  // ============================================================================

  /**
   * Create a new user MCP
   */
  async create(data: NewUserMcp): Promise<UserMcp> {
    const [mcp] = await dbWrite.insert(userMcps).values(data).returning();
    return mcp;
  },

  /**
   * Update an MCP
   */
  async update(
    id: string,
    data: Partial<Omit<UserMcp, "id" | "created_at">>,
  ): Promise<UserMcp | null> {
    const [mcp] = await dbWrite
      .update(userMcps)
      .set({ ...data, updated_at: new Date() })
      .where(eq(userMcps.id, id))
      .returning();
    return mcp ?? null;
  },

  /**
   * Delete an MCP
   */
  async delete(id: string): Promise<boolean> {
    const result = await dbWrite.delete(userMcps).where(eq(userMcps.id, id));
    return mutateRowCount(result) > 0;
  },

  /**
   * Increment usage stats
   */
  async incrementUsage(
    id: string,
    creditsEarned: number,
    x402EarnedUsd: number = 0,
  ): Promise<void> {
    await dbWrite
      .update(userMcps)
      .set({
        total_requests: sql`${userMcps.total_requests} + 1`,
        total_credits_earned: sql`${userMcps.total_credits_earned} + ${creditsEarned}`,
        total_x402_earned_usd: sql`${userMcps.total_x402_earned_usd} + ${x402EarnedUsd}`,
        last_used_at: new Date(),
        updated_at: new Date(),
      })
      .where(eq(userMcps.id, id));
  },

  /**
   * Update status
   */
  async updateStatus(id: string, status: UserMcp["status"]): Promise<UserMcp | null> {
    const updateData: Partial<UserMcp> = {
      status,
      updated_at: new Date(),
    };

    if (status === "live") {
      updateData.published_at = new Date();
    }

    const [mcp] = await dbWrite
      .update(userMcps)
      .set(updateData)
      .where(eq(userMcps.id, id))
      .returning();
    return mcp ?? null;
  },
};

/**
 * MCP Usage Repository
 *
 * Tracks usage of user MCPs.
 */
export const mcpUsageRepository = {
  // ============================================================================
  // READ OPERATIONS (use read-intent connection)
  // ============================================================================

  /**
   * Get usage by MCP
   */
  async getByMcp(
    mcpId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<McpUsage[]> {
    const { limit = 100, offset = 0 } = options;

    return dbRead
      .select()
      .from(mcpUsage)
      .where(eq(mcpUsage.mcp_id, mcpId))
      .orderBy(desc(mcpUsage.created_at))
      .limit(limit)
      .offset(offset);
  },

  /**
   * Get usage by organization (as consumer)
   */
  async getByOrganization(
    organizationId: string,
    options: { limit?: number; offset?: number } = {},
  ): Promise<McpUsage[]> {
    const { limit = 100, offset = 0 } = options;

    return dbRead
      .select()
      .from(mcpUsage)
      .where(eq(mcpUsage.organization_id, organizationId))
      .orderBy(desc(mcpUsage.created_at))
      .limit(limit)
      .offset(offset);
  },

  /**
   * Get aggregated stats for an MCP
   */
  async getStats(mcpId: string): Promise<{
    totalRequests: number;
    /** @deprecated Legacy base-price points (100 points = $1). */
    totalCreditsCharged: number;
    baseAmountUsd: string;
    affiliateFeeUsd: string;
    platformFeeUsd: string;
    totalAmountUsd: string;
    feeComponentsKnown: boolean;
    totalX402Usd: number;
    uniqueOrgs: number;
  }> {
    const [result] = await dbRead
      .select({
        totalRequests: sql<number>`sum(${mcpUsage.request_count})`,
        totalCreditsCharged: sql<number>`sum(${mcpUsage.credits_charged})`,
        baseAmountUsd: sql<string>`sum(${mcpUsage.base_amount_usd})`,
        affiliateFeeUsd: sql<string>`sum(${mcpUsage.affiliate_fee_usd})`,
        platformFeeUsd: sql<string>`sum(${mcpUsage.platform_fee_usd})`,
        totalAmountUsd: sql<string>`sum(${mcpUsage.total_amount_usd})`,
        feeComponentsKnown: sql<boolean>`coalesce(bool_and(${mcpUsage.fee_components_known}), true)`,
        totalX402Usd: sql<number>`sum(${mcpUsage.x402_amount_usd})`,
        uniqueOrgs: sql<number>`count(distinct ${mcpUsage.organization_id})`,
      })
      .from(mcpUsage)
      .where(eq(mcpUsage.mcp_id, mcpId));

    return {
      totalRequests: parseUsageAggregate(result?.totalRequests, "totalRequests"),
      totalCreditsCharged: parseUsageAggregate(result?.totalCreditsCharged, "totalCreditsCharged"),
      baseAmountUsd: parseUsageMoneyAggregate(result?.baseAmountUsd, "baseAmountUsd"),
      affiliateFeeUsd: parseUsageMoneyAggregate(result?.affiliateFeeUsd, "affiliateFeeUsd"),
      platformFeeUsd: parseUsageMoneyAggregate(result?.platformFeeUsd, "platformFeeUsd"),
      totalAmountUsd: parseUsageMoneyAggregate(result?.totalAmountUsd, "totalAmountUsd"),
      feeComponentsKnown: result?.feeComponentsKnown ?? true,
      totalX402Usd: parseUsageAggregate(result?.totalX402Usd, "totalX402Usd"),
      uniqueOrgs: parseUsageAggregate(result?.uniqueOrgs, "uniqueOrgs"),
    };
  },

  // ============================================================================
  // WRITE OPERATIONS (use primary)
  // ============================================================================

  /**
   * Record MCP usage. When `settlement_id` is set the insert is idempotent:
   * a concurrent duplicate settlement of the same payment event reuses the
   * committed row instead of inserting a second one (#22961). `created` says
   * whether this call inserted the row (only that caller may bump counters).
   */
  async create(data: NewMcpUsage): Promise<McpUsage & { created: boolean }> {
    const { usage, created } = await this.createWithStats(data);
    return { ...usage, created };
  },

  /**
   * Atomically claim the settlement's usage row AND, when this call is the
   * one that inserted it, bump the MCP stats counters in the same statement
   * (#22961). Splitting insert and increment leaves a crash window that a
   * re-delivery cannot distinguish (counter lost forever) and lets the race
   * loser double-bump; one CTE makes the unique settlement index the sole
   * exactly-once gate for both effects.
   */
  async createWithStats(
    data: NewMcpUsage,
    stats?: { mcpId: string; creatorEarnings: number; x402EarnedUsd?: number },
  ): Promise<{ usage: McpUsage; created: boolean }> {
    if (!data.settlement_id && stats) {
      // Free-tier/settlement-less usage: no unique settlement key to gate
      // on, but usage row and stats must still commit atomically — one CTE,
      // same shape as the keyed branch minus the conflict arbitration.
      const x402Free = stats.x402EarnedUsd ?? 0;
      const result = await dbWrite.execute<{ id: string }>(sql`
        WITH ins AS (
          INSERT INTO mcp_usage (
            mcp_id, organization_id, user_id, tool_name, request_count,
            credits_charged, base_amount_usd, affiliate_fee_usd, platform_fee_usd,
            total_amount_usd, fee_components_known, x402_amount_usd, payment_type,
            creator_earnings, platform_earnings, metadata, settlement_id
          ) VALUES (
            ${data.mcp_id}, ${data.organization_id}, ${data.user_id ?? null}, ${data.tool_name}, ${data.request_count ?? 1},
            ${data.credits_charged}, ${data.base_amount_usd}, ${data.affiliate_fee_usd}, ${data.platform_fee_usd},
            ${data.total_amount_usd}, ${data.fee_components_known ?? true}, ${data.x402_amount_usd}, ${data.payment_type},
            ${data.creator_earnings}, ${data.platform_earnings}, ${data.metadata ?? {}}, NULL
          )
          RETURNING id
        ),
        upd AS (
          UPDATE user_mcps SET
            total_requests = user_mcps.total_requests + 1,
            total_credits_earned = user_mcps.total_credits_earned + ${stats.creatorEarnings},
            total_x402_earned_usd = user_mcps.total_x402_earned_usd + ${x402Free},
            last_used_at = now(),
            updated_at = now()
          WHERE user_mcps.id = ${stats.mcpId}
            AND EXISTS (SELECT 1 FROM ins)
          RETURNING 1 AS bumped
        )
        SELECT (SELECT id FROM ins LIMIT 1) AS id
      `);
      const id = result.rows?.[0]?.id;
      if (!id) {
        throw new Error("MCP free-tier usage insert returned no row");
      }
      return { usage: { ...data, id } as McpUsage, created: true };
    }
    if (!data.settlement_id || !stats) {
      const [usage] = await dbWrite.insert(mcpUsage).values(data).returning();
      return { usage, created: true };
    }
    const x402 = stats.x402EarnedUsd ?? 0;
    // The insert and the stats bump are ONE statement so the unique
    // settlement index is the sole exactly-once gate for both effects. The
    // conflict-loser row is NOT re-read here: under MVCC the conflicting row
    // may be visible to ON CONFLICT arbitration yet invisible to this
    // statement's snapshot, so the fallback read runs as a second statement
    // (the same pattern as credits.ts's idempotent credit increase).
    const result = await dbWrite.execute<{ id?: string; created?: boolean }>(sql`
      WITH ins AS (
        INSERT INTO mcp_usage (
          mcp_id, organization_id, user_id, tool_name, request_count,
          credits_charged, base_amount_usd, affiliate_fee_usd, platform_fee_usd,
          total_amount_usd, fee_components_known, x402_amount_usd, payment_type,
          creator_earnings, platform_earnings, metadata, settlement_id
        ) VALUES (
          ${data.mcp_id}, ${data.organization_id}, ${data.user_id ?? null}, ${data.tool_name}, ${data.request_count ?? 1},
          ${data.credits_charged}, ${data.base_amount_usd}, ${data.affiliate_fee_usd}, ${data.platform_fee_usd},
          ${data.total_amount_usd}, ${data.fee_components_known ?? true}, ${data.x402_amount_usd}, ${data.payment_type},
          ${data.creator_earnings}, ${data.platform_earnings}, ${data.metadata ?? {}}, ${data.settlement_id}
        )
        ON CONFLICT (settlement_id) DO NOTHING
        RETURNING id
      ),
      upd AS (
        UPDATE user_mcps SET
          total_requests = user_mcps.total_requests + 1,
          total_credits_earned = user_mcps.total_credits_earned + ${stats.creatorEarnings},
          total_x402_earned_usd = user_mcps.total_x402_earned_usd + ${x402},
          last_used_at = now(),
          updated_at = now()
        WHERE user_mcps.id = ${stats.mcpId}
          AND EXISTS (SELECT 1 FROM ins)
        RETURNING 1 AS bumped
      )
      SELECT (SELECT id FROM ins LIMIT 1) AS id, TRUE AS created
    `);
    const inserted = result.rows?.[0]?.id;
    if (inserted) {
      return { usage: { ...data, id: inserted } as McpUsage, created: true };
    }
    // Conflict (or rare empty RETURNING): re-read the committed row in a
    // FRESH statement so the winner's commit is visible.
    const [existing] = await dbWrite
      .select()
      .from(mcpUsage)
      .where(eq(mcpUsage.settlement_id, data.settlement_id))
      .limit(1);
    if (!existing) {
      throw new Error("MCP usage claim lost the committed row");
    }
    return { usage: existing, created: false };
  },
};

// Re-export types
export type { McpUsage, NewMcpUsage, NewUserMcp, UserMcp };
