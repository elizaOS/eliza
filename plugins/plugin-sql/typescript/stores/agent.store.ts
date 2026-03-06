import { type Agent, type UUID, logger } from "@elizaos/core";
import { count, eq, inArray, sql } from "drizzle-orm";
import { agentTable } from "../tables";
import type { DrizzleDatabase } from "../types";


/**
 * Asynchronously retrieves a list of agents from the database.
 *
 * @param {DrizzleDatabase} db - The database instance.
 * @returns {Promise<Partial<Agent>[]>} A Promise that resolves to an array of Agent objects.
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
 *
 * @param {DrizzleDatabase} tx - The database transaction.
 * @param {UUID} agentId - The ID of the agent.
 * @param {T} updatedSettings - The settings object with updates.
 * @param {Record<string, unknown>} [existingSettings] - Pre-fetched current settings (avoids extra SELECT).
 * @returns {Promise<T>} The merged settings object.
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
    // If source is explicitly null, it means the intention is to set this entire branch to null (or delete if top-level handled by caller).
    // For recursive calls, if a sub-object in source is null, it effectively means "remove this sub-object from target".
    // However, our primary deletion signal is a *property value* being null within an object.
    if (source === null) {
      // If the entire source for a given key is null, we treat it as "delete this key from target"
      // by returning undefined, which the caller can use to delete the key.
      return undefined;
    }

    // If source is an array or a primitive, it replaces the target value.
    if (Array.isArray(source) || typeof source !== "object") {
      return source;
    }

    // Initialize output. If target is not an object, start with an empty one to merge source into.
    const output =
      typeof target === "object" && target !== null && !Array.isArray(target)
        ? { ...target }
        : {};

    for (const key of Object.keys(source)) {
      // Iterate over source keys
      const sourceValue = source[key];

      if (sourceValue === null) {
        // If a value in source is null, delete the corresponding key from output.
        delete output[key];
      } else if (typeof sourceValue === "object" && !Array.isArray(sourceValue)) {
        // If value is an object, recurse.
        const nestedMergeResult = deepMerge(output[key], sourceValue as Record<string, unknown>);
        if (nestedMergeResult === undefined) {
          // If recursive merge resulted in undefined (meaning the nested object should be deleted)
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
    // An object is empty if all its keys were deleted or resulted in undefined.
    // This is a more direct check than iterating 'output' after building it.
    if (Object.keys(output).length === 0) {
      // If the source itself was not an explicitly empty object,
      // and the merge resulted in an empty object, signal deletion.
      if (!(typeof source === "object" && source !== null && Object.keys(source).length === 0)) {
        return undefined; // Signal to delete this (parent) key if it became empty.
      }
    }

    return output;
  }; // End of deepMerge

  const finalSettings = deepMerge(currentSettings, updatedSettings);
  // If the entire settings object becomes undefined (e.g. all keys removed),
  // return an empty object instead of undefined/null to keep the settings field present.
  return (finalSettings ?? {}) as T;
}


// ====== BATCH METHODS ======

/**
 * Retrieves multiple agents by their IDs from the database.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID[]} agentIds - Array of agent IDs to retrieve.
 * @returns {Promise<Agent[]>} Array of agents (only found agents are returned).
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
 * Uses onConflictDoNothing() to skip duplicates instead of SELECT-to-check pattern.
 * @param {DrizzleDatabase} db - The database instance.
 * @param {Agent[]} agents - Array of agents to create.
 * @returns {Promise<boolean>} True if all agents were created successfully.
 */
export async function createAgents(db: DrizzleDatabase, agents: Agent[]): Promise<UUID[]> {
  if (agents.length === 0) return [];

  try {
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
      .onConflictDoNothing({ target: agentTable.id });

    return agents.map((a) => a.id);
  } catch (error) {
    logger.error(
      {
        src: "plugin:sql",
        count: agents.length,
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to create agents"
    );
    throw error;
  }
}

/**
 * Upsert agents (insert or update by ID)
 * 
 * WHY: Atomic insert-or-update eliminates race conditions in ensureAgentExists.
 * PostgreSQL's ON CONFLICT DO UPDATE is a single atomic SQL statement - no
 * SELECT-then-INSERT race window where two concurrent calls could both try
 * to insert the same agent.
 * 
 * WHY DO UPDATE SET instead of DO NOTHING: We want to update existing agents
 * with new values if they've changed (name, bio, system config). DO NOTHING
 * would skip updates entirely, leaving stale data.
 * 
 * PERFORMANCE: Single multi-row INSERT with ON CONFLICT is 10-100x faster than
 * N separate get-check-create cycles.
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
    .onConflictDoUpdate({
      target: agentTable.id,
      set: {
        name: agentTable.name,
        bio: agentTable.bio,
        username: agentTable.username,
        system: agentTable.system,
        clients: agentTable.clients,
        config: agentTable.config,
        settings: agentTable.settings,
        secrets: agentTable.secrets,
        updatedAt: new Date(),
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
 * @param {DrizzleDatabase} db - The database instance.
 * @param {Array<{agentId: UUID; agent: Partial<Agent>}>} updates - Array of agent updates.
 * @returns {Promise<boolean>} True if all agents were updated successfully.
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
    const jsonbCaseFn = (col: any, items: Array<{ id: UUID; val: unknown }>) => {
      const cases = items.map(
        (i) => sql`WHEN ${agentTable.id} = ${i.id} THEN ${JSON.stringify(i.val)}::jsonb`
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

    // JSONB columns
    const bioItems = field("bio");
    if (bioItems.length > 0) setObj.bio = jsonbCaseFn(agentTable.bio, bioItems);
    const msgItems = field("messageExamples");
    if (msgItems.length > 0) setObj.messageExamples = jsonbCaseFn(agentTable.messageExamples, msgItems);
    const postItems = field("postExamples");
    if (postItems.length > 0) setObj.postExamples = jsonbCaseFn(agentTable.postExamples, postItems);
    const topicItems = field("topics");
    if (topicItems.length > 0) setObj.topics = jsonbCaseFn(agentTable.topics, topicItems);
    const adjItems = field("adjectives");
    if (adjItems.length > 0) setObj.adjectives = jsonbCaseFn(agentTable.adjectives, adjItems);
    const plugItems = field("plugins");
    if (plugItems.length > 0) setObj.plugins = jsonbCaseFn(agentTable.plugins, plugItems);
    const settItems = field("settings");
    if (settItems.length > 0) setObj.settings = jsonbCaseFn(agentTable.settings, settItems);
    const styleItems = field("style");
    if (styleItems.length > 0) setObj.style = jsonbCaseFn(agentTable.style, styleItems);

    setObj.updatedAt = new Date();

    await db
      .update(agentTable)
      .set(setObj)
      .where(inArray(agentTable.id, ids));

    return true;
  } catch (error) {
    logger.error(
      {
        src: "plugin:sql",
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
 * @param {DrizzleDatabase} db - The database instance.
 * @param {UUID[]} agentIds - Array of agent IDs to delete.
 * @returns {Promise<boolean>} True if all agents were deleted successfully.
 */
export async function deleteAgents(db: DrizzleDatabase, agentIds: UUID[]): Promise<boolean> {
  if (agentIds.length === 0) return true;

  try {
    await db.delete(agentTable).where(inArray(agentTable.id, agentIds));
    return true;
  } catch (error) {
    logger.error(
      {
        src: "plugin:sql",
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
 * Asynchronously counts the number of agents in the database.
 * @param {DrizzleDatabase} db - The database instance.
 * @returns {Promise<number>} A Promise that resolves to the number of agents in the database.
 */
export async function countAgents(db: DrizzleDatabase): Promise<number> {
  try {
    const result = await db.select({ count: count() }).from(agentTable);

    const result0 = result[0];
    return result0?.count || 0;
  } catch (error) {
    logger.error(
      {
        src: "plugin:sql",
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to count agents"
    );
    return 0;
  }
}

/**
 * Clean up the agents table by removing all agents.
 * This is used during server startup to ensure no orphaned agents exist
 * from previous crashes or improper shutdowns.
 * @param {DrizzleDatabase} db - The database instance.
 * @returns {Promise<void>}
 */
export async function cleanupAgents(db: DrizzleDatabase): Promise<void> {
  try {
    await db.delete(agentTable);
  } catch (error) {
    logger.error(
      {
        src: "plugin:sql",
        error: error instanceof Error ? error.message : String(error),
      },
      "Failed to clean up agent table"
    );
    throw error;
  }
}
