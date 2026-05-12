import { and, desc, eq, ilike, or, sql } from "drizzle-orm";
import { mutateRowCount } from "@/db/execute-helpers";
import { dbRead, dbWrite } from "@/db/helpers";
import {
  type McpUsage,
  mcpUsage,
  type NewMcpUsage,
  type NewUserMcp,
  type UserMcp,
  userMcps,
} from "@/db/schemas";

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
        or(ilike(userMcps.name, `%${search}%`), ilike(userMcps.description, `%${search}%`))!,
      );
    }

    return dbRead
      .select()
      .from(userMcps)
      .where(and(...conditions))
      .orderBy(desc(userMcps.total_requests), desc(userMcps.created_at))
      .limit(limit)
      .offset(offset);
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
    totalCreditsCharged: number;
    totalX402Usd: number;
    uniqueOrgs: number;
  }> {
    const [result] = await dbRead
      .select({
        totalRequests: sql<number>`sum(${mcpUsage.request_count})`,
        totalCreditsCharged: sql<number>`sum(${mcpUsage.credits_charged})`,
        totalX402Usd: sql<number>`sum(${mcpUsage.x402_amount_usd})`,
        uniqueOrgs: sql<number>`count(distinct ${mcpUsage.organization_id})`,
      })
      .from(mcpUsage)
      .where(eq(mcpUsage.mcp_id, mcpId));

    return {
      totalRequests: Number(result?.totalRequests ?? 0),
      totalCreditsCharged: Number(result?.totalCreditsCharged ?? 0),
      totalX402Usd: Number(result?.totalX402Usd ?? 0),
      uniqueOrgs: Number(result?.uniqueOrgs ?? 0),
    };
  },

  // ============================================================================
  // WRITE OPERATIONS (use primary)
  // ============================================================================

  /**
   * Record MCP usage
   */
  async create(data: NewMcpUsage): Promise<McpUsage> {
    const [usage] = await dbWrite.insert(mcpUsage).values(data).returning();
    return usage;
  },
};

// Re-export types
export type { McpUsage, NewMcpUsage, NewUserMcp, UserMcp };
