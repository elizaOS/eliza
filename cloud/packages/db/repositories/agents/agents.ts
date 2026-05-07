/**
 * Agents repository.
 *
 * Pure database operations for the elizaOS agents table.
 * Used to get agent info without spinning up the full runtime.
 *
 * Read operations → dbRead (read-intent connection)
 * Write operations → dbWrite (primary)
 */

import type { Agent } from "@elizaos/core";
import { eq, inArray } from "drizzle-orm";
import { dbRead, dbWrite } from "@/db/helpers";
import { agentTable } from "@/db/schemas/eliza";
import { logger } from "@/lib/utils/logger";

const toDate = (value: Date | string | number | bigint | null | undefined): Date => {
  if (value instanceof Date) {
    return value;
  }

  if (typeof value === "bigint") {
    return new Date(Number(value));
  }

  return new Date(value ?? Date.now());
};

/**
 * Agent information returned from database.
 *
 * Matches the agentTable schema from @elizaos/plugin-sql.
 */
export interface AgentInfo {
  id: string;
  name: string;
  username?: string | null;
  bio?: string | string[] | null;
  system?: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  settings?: Record<string, unknown> | null;
}

/**
 * Repository for elizaOS agent database operations.
 */
export class AgentsRepository {
  // ============================================================================
  // READ OPERATIONS (use read-intent connection)
  // ============================================================================

  /**
   * Gets an agent by ID.
   */
  async findById(agentId: string): Promise<AgentInfo | null> {
    const result = await dbRead
      .select({
        id: agentTable.id,
        name: agentTable.name,
        username: agentTable.username,
        bio: agentTable.bio,
        system: agentTable.system,
        enabled: agentTable.enabled,
        createdAt: agentTable.createdAt,
        updatedAt: agentTable.updatedAt,
        settings: agentTable.settings,
      })
      .from(agentTable)
      .where(eq(agentTable.id, agentId))
      .limit(1);

    return result[0] || null;
  }

  /**
   * Gets multiple agents by IDs.
   */
  async findByIds(agentIds: string[]): Promise<AgentInfo[]> {
    if (agentIds.length === 0) return [];

    return await dbRead
      .select({
        id: agentTable.id,
        name: agentTable.name,
        username: agentTable.username,
        bio: agentTable.bio,
        system: agentTable.system,
        enabled: agentTable.enabled,
        createdAt: agentTable.createdAt,
        updatedAt: agentTable.updatedAt,
        settings: agentTable.settings,
      })
      .from(agentTable)
      .where(inArray(agentTable.id, agentIds));
  }

  /**
   * Checks if an agent exists.
   */
  async exists(agentId: string): Promise<boolean> {
    const result = await dbRead
      .select({ id: agentTable.id })
      .from(agentTable)
      .where(eq(agentTable.id, agentId))
      .limit(1);

    return result.length > 0;
  }

  // ============================================================================
  // WRITE OPERATIONS (use primary)
  // ============================================================================

  /**
   * Creates a new agent.
   *
   * @returns True if successful, false if agent with same ID already exists.
   * @throws Error if creation fails for reasons other than duplicate ID.
   */
  async create(agent: Partial<Agent>): Promise<boolean> {
    // Check for existing agent with the same ID only (names can be duplicated)
    // Use the write connection so the duplicate check sees the latest row.
    if (agent.id) {
      const existing = await dbWrite
        .select({ id: agentTable.id })
        .from(agentTable)
        .where(eq(agentTable.id, agent.id))
        .limit(1);

      if (existing.length > 0) {
        logger.warn("[AgentsRepository] Attempted duplicate agent create", {
          agentId: agent.id,
        });
        return false;
      }
    }

    await dbWrite.insert(agentTable).values({
      ...agent,
      createdAt: toDate(agent.createdAt),
      updatedAt: toDate(agent.updatedAt),
    });

    logger.debug("[AgentsRepository] Created agent", {
      agentId: agent.id,
    });
    return true;
  }

  /**
   * Gets an agent's avatar URL from settings.
   */
  async getAvatarUrl(agentId: string): Promise<string | undefined> {
    const agent = await this.findById(agentId);
    return agent?.settings?.avatarUrl as string | undefined;
  }

  /**
   * Gets basic agent display information (name, avatar).
   */
  async getDisplayInfo(agentId: string): Promise<{
    id: string;
    name: string;
    avatarUrl?: string;
  } | null> {
    const agent = await this.findById(agentId);
    if (!agent) return null;

    return {
      id: agent.id,
      name: agent.name,
      avatarUrl: agent.settings?.avatarUrl as string | undefined,
    };
  }
}

/**
 * Singleton instance of AgentsRepository.
 */
export const agentsRepository = new AgentsRepository();
