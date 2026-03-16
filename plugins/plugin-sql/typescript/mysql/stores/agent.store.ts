import { type Agent, logger, type UUID } from "@elizaos/core";
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { agentTable } from "../tables";
import type { DrizzleDatabase } from "../types";


/**
 * Retrieves a list of agents from the database.
 */
export async function getAgents(db: DrizzleDatabase): Promise<Partial<Agent>[]> {
  const rows = await db
    .select({
      id: agentTable.id,
      name: agentTable.name,
      bio: agentTable.bio,
    })
    .from(agentTable);

  return rows.map(
    (row) =>
      ({
        ...row,
        id: row.id as UUID,
        bio: (row.bio === null ? "" : Array.isArray(row.bio) ? row.bio : row.bio) as
          | string
          | string[],
      }) as Partial<Agent>
  );
}



/**
 * Merges updated agent settings with existing settings,
 * with special handling for nested objects like secrets.
 *
 * WHY the optional existingSettings param: callers that already fetched the
 * agent row (e.g. updateAgents) can pass in the current settings, eliminating
 * a redundant SELECT. When not provided, falls back to reading from DB.
 */
export async function mergeAgentSettings<T extends Record<string, unknown>>(
  tx: DrizzleDatabase,
  agentId: UUID,
  updatedSettings: T,
  existingSettings?: Record<string, unknown>
): Promise<T> {
  let currentSettings = existingSettings;
  if (currentSettings === undefined) {
    const currentAgent = await tx
      .select({ settings: agentTable.settings })
      .from(agentTable)
      .where(eq(agentTable.id, agentId))
      .limit(1);

    currentSettings =
      currentAgent.length > 0 && currentAgent[0].settings
        ? (currentAgent[0].settings as Record<string, unknown>)
        : {};
  }

  const deepMerge = (
    target: Record<string, unknown> | unknown,
    source: Record<string, unknown>
  ): Record<string, unknown> | undefined => {
    // If source is explicitly null, treat as "delete this key from target"
    if (source === null) {
      return undefined;
    }

    // If source is an array or a primitive, it replaces the target value.
    if (Array.isArray(source) || typeof source !== "object") {
      return source;
    }

    // Initialize output
    const output =
      typeof target === "object" && target !== null && !Array.isArray(target)
        ? { ...target }
        : {};

    for (const key of Object.keys(source)) {
      const sourceValue = source[key];

      if (sourceValue === null) {
        // If a value in source is null, delete the corresponding key from output.
        delete output[key];
      } else if (typeof sourceValue === "object" && !Array.isArray(sourceValue)) {
        // If value is an object, recurse.
        const nestedMergeResult = deepMerge(output[key], sourceValue as Record<string, unknown>);
        if (nestedMergeResult === undefined) {
          delete output[key];
        } else {
          output[key] = nestedMergeResult;
        }
      } else {
        // Primitive or array value from source, assign it.
        output[key] = sourceValue;
      }
    }

    // After processing all keys from source, check if output became empty.
    if (Object.keys(output).length === 0) {
      if (!(typeof source === "object" && source !== null && Object.keys(source).length === 0)) {
        return undefined;
      }
    }

    return output;
  };

  const finalSettings = deepMerge(currentSettings, updatedSettings);
  return (finalSettings ?? {}) as T;
}

/**
 * Deletes an agent with the specified UUID and all related entries.
 * MySQL does NOT support RETURNING - uses simple delete + existence check.
 */

// ====== BATCH METHODS ======

/**
 * Retrieves multiple agents by their IDs from the database.
 */
export async function getAgentsByIds(db: DrizzleDatabase, agentIds: UUID[]): Promise<Agent[]> {
  if (agentIds.length === 0) return [];

  const rows = await db
    .select()
    .from(agentTable)
    .where(inArray(agentTable.id, agentIds));

  return rows.map((row) => {
    const bioValue = !row.bio ? "" : Array.isArray(row.bio) ? row.bio : row.bio;
    return {
      ...row,
      username: row.username || "",
      id: row.id as UUID,
      system: !row.system ? undefined : row.system,
      bio: bioValue as string | string[],
      createdAt: row.createdAt.getTime(),
      updatedAt: row.updatedAt.getTime(),
    } as unknown as Agent;
  });
}

/**
 * Creates multiple agents in the database.
 */
export async function createAgents(db: DrizzleDatabase, agents: Agent[]): Promise<UUID[]> {
  if (agents.length === 0) return [];

  try {
    // Check for existing agents
    if (agents.some(a => a.id)) {
      const ids = agents.map(a => a.id).filter(Boolean) as UUID[];
      if (ids.length > 0) {
        const existing = await db
          .select({ id: agentTable.id })
          .from(agentTable)
          .where(inArray(agentTable.id, ids));

        if (existing.length > 0) {
          logger.warn(
            { src: "plugin:mysql", count: existing.length },
            "Attempted to create agents with duplicate IDs"
          );
          throw new Error(`${existing.length} agents already exist with the given IDs`);
        }
      }
    }

    await db.transaction(async (tx) => {
      const agentsData = agents.map(agent => ({
        ...agent,
        createdAt: new Date(
          typeof agent.createdAt === "bigint"
            ? Number(agent.createdAt)
            : agent.createdAt || Date.now()
        ),
        updatedAt: new Date(
          typeof agent.updatedAt === "bigint"
            ? Number(agent.updatedAt)
            : agent.updatedAt || Date.now()
        ),
      }));
      await tx
        .insert(agentTable)
        .values(agentsData as unknown as (typeof agentTable.$inferInsert)[]);
    });

    return agents.map(a => a.id);
  } catch (error) {
    logger.error(
      {
        src: "plugin:mysql",
        count: agents.length,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to create agents"
    );
    throw error;
  }
}

/**
 * Upsert agents (insert or update by ID) - MySQL version
 * 
 * WHY: Same rationale as PostgreSQL version - eliminates race conditions in
 * ensureAgentExists. MySQL uses ON DUPLICATE KEY UPDATE instead of ON CONFLICT.
 * 
 * WHY different SQL syntax: MySQL 8.0.20 deprecated VALUES() in ON DUPLICATE KEY,
 * but Drizzle doesn't yet support the new alias syntax. We use sql`VALUES(column)`
 * which still works but generates deprecation warnings. This will be fixed when
 * Drizzle adds support for the new MySQL 8.0.20+ syntax.
 * 
 * @param {DrizzleDatabase} db - The database instance
 * @param {Agent[]} agents - Array of agents to upsert (id required for each)
 */
export async function upsertAgents(db: DrizzleDatabase, agents: Partial<Agent>[]): Promise<void> {
  if (agents.length === 0) return;

  const agentsData = agents.map((agent) => ({
    ...agent,
    createdAt: new Date(
      typeof agent.createdAt === "bigint"
        ? Number(agent.createdAt)
        : agent.createdAt || Date.now()
    ),
    updatedAt: new Date(
      typeof agent.updatedAt === "bigint"
        ? Number(agent.updatedAt)
        : agent.updatedAt || Date.now()
    ),
  }));

  await db
    .insert(agentTable)
    .values(agentsData as unknown as (typeof agentTable.$inferInsert)[])
    .onDuplicateKeyUpdate({
      set: {
        name: sql.raw('VALUES(`name`)'),
        bio: sql.raw('VALUES(`bio`)'),
        username: sql.raw('VALUES(`username`)'),
        system: sql.raw('VALUES(`system`)'),
        clients: sql.raw('VALUES(`clients`)'),
        config: sql.raw('VALUES(`config`)'),
        settings: sql.raw('VALUES(`settings`)'),
        secrets: sql.raw('VALUES(`secrets`)'),
        updatedAt: sql`NOW()`,
      },
    });
}

/**
 * Updates multiple agents in the database using a single CASE-based UPDATE.
 *
 * WHY single statement: reduces N SELECTs + N UPDATEs to at most 1 batch
 * SELECT (for settings merge) + 1 CASE UPDATE. Each updatable column gets
 * its own CASE expression; the ELSE clause preserves originals for rows
 * that don't touch that column.
 *
 * MySQL: uses CAST(value AS JSON) instead of ::jsonb for JSON columns.
 */
export async function updateAgents(
  db: DrizzleDatabase,
  updates: Array<{ agentId: UUID; agent: Partial<Agent> }>
): Promise<boolean> {
  if (updates.length === 0) return true;

  try {
    for (const { agentId } of updates) {
      if (!agentId) throw new Error("Agent ID is required for update");
    }

    // Batch-fetch current settings for agents that need a merge (1 query)
    const settingsUpdates = updates.filter((u) => u.agent?.settings);
    if (settingsUpdates.length > 0) {
      const sIds = settingsUpdates.map((u) => u.agentId);
      const rows = await db
        .select({ id: agentTable.id, settings: agentTable.settings })
        .from(agentTable)
        .where(inArray(agentTable.id, sIds));
      const sMap = new Map(
        rows.map((r) => [r.id, (r.settings ?? {}) as Record<string, unknown>])
      );
      for (const u of settingsUpdates) {
        const existing = sMap.get(u.agentId) || {};
        u.agent.settings = await mergeAgentSettings(db, u.agentId, u.agent.settings!, existing);
      }
    }

    // Build per-column CASE expressions
    const ids = updates.map((u) => u.agentId);
    const setObj: Record<string, unknown> = {};

    const textCaseFn = (col: any, items: Array<{ id: UUID; val: unknown }>) => {
      const cases = items.map((i) => sql`WHEN ${agentTable.id} = ${i.id} THEN ${i.val}`);
      return sql`CASE ${sql.join(cases, sql` `)} ELSE ${col} END`;
    };
    const jsonCaseFn = (col: any, items: Array<{ id: UUID; val: unknown }>) => {
      const cases = items.map(
        (i) => sql`WHEN ${agentTable.id} = ${i.id} THEN CAST(${JSON.stringify(i.val)} AS JSON)`
      );
      return sql`CASE ${sql.join(cases, sql` `)} ELSE ${col} END`;
    };
    const field = <K extends keyof Agent>(key: K) =>
      updates
        .filter((u) => u.agent[key] !== undefined)
        .map((u) => ({ id: u.agentId, val: u.agent[key] }));

    // Text / boolean columns
    const nameItems = field("name");
    if (nameItems.length > 0) setObj.name = textCaseFn(agentTable.name, nameItems);
    const usernameItems = field("username");
    if (usernameItems.length > 0) setObj.username = textCaseFn(agentTable.username, usernameItems);
    const systemItems = field("system");
    if (systemItems.length > 0) setObj.system = textCaseFn(agentTable.system, systemItems);
    const enabledItems = field("enabled");
    if (enabledItems.length > 0) setObj.enabled = textCaseFn(agentTable.enabled, enabledItems);

    // JSON columns (MySQL: CAST AS JSON)
    const bioItems = field("bio");
    if (bioItems.length > 0) setObj.bio = jsonCaseFn(agentTable.bio, bioItems);
    const msgItems = field("messageExamples");
    if (msgItems.length > 0) setObj.messageExamples = jsonCaseFn(agentTable.messageExamples, msgItems);
    const postItems = field("postExamples");
    if (postItems.length > 0) setObj.postExamples = jsonCaseFn(agentTable.postExamples, postItems);
    const topicItems = field("topics");
    if (topicItems.length > 0) setObj.topics = jsonCaseFn(agentTable.topics, topicItems);
    const adjItems = field("adjectives");
    if (adjItems.length > 0) setObj.adjectives = jsonCaseFn(agentTable.adjectives, adjItems);
    const plugItems = field("plugins");
    if (plugItems.length > 0) setObj.plugins = jsonCaseFn(agentTable.plugins, plugItems);
    const settItems = field("settings");
    if (settItems.length > 0) setObj.settings = jsonCaseFn(agentTable.settings, settItems);
    const styleItems = field("style");
    if (styleItems.length > 0) setObj.style = jsonCaseFn(agentTable.style, styleItems);

    setObj.updatedAt = new Date();

    await db
      .update(agentTable)
      .set(setObj)
      .where(inArray(agentTable.id, ids));

    return true;
  } catch (error) {
    logger.error(
      {
        src: "plugin:mysql",
        count: updates.length,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to update agents"
    );
    return false;
  }
}

/**
 * Deletes multiple agents from the database.
 */
export async function deleteAgents(db: DrizzleDatabase, agentIds: UUID[]): Promise<boolean> {
  if (agentIds.length === 0) return true;

  try {
    await db.delete(agentTable).where(inArray(agentTable.id, agentIds));
    return true;
  } catch (error) {
    logger.error(
      {
        src: "plugin:mysql",
        count: agentIds.length,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to delete agents"
    );
    throw error;
  }
}

// ====== END BATCH METHODS ======

/**
 * Counts the number of agents in the database.
 */
export async function countAgents(db: DrizzleDatabase): Promise<number> {
  try {
    const result = await db.select({ count: count() }).from(agentTable);

    const result0 = result[0];
    return result0?.count || 0;
  } catch (error) {
    logger.error(
      {
        src: "plugin:mysql",
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to count agents"
    );
    return 0;
  }
}

/**
 * Clean up the agents table by removing all agents.
 * Used during server startup to ensure no orphaned agents exist
 * from previous crashes or improper shutdowns.
 */
export async function cleanupAgents(db: DrizzleDatabase): Promise<void> {
  try {
    await db.delete(agentTable);
  } catch (error) {
    logger.error(
      {
        src: "plugin:mysql",
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to clean up agent table"
    );
    throw error;
  }
}
