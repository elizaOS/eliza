/**
 * Direct Database Adapter
 *
 * Creates a database adapter from a direct PostgreSQL connection URL.
 * This is used by the ElizaOS Cloud platform itself which already has
 * database access and doesn't need to provision via API.
 *
 * For users who want managed database provisioning, use createCloudDatabaseAdapter instead.
 */

import type { UUID } from "@elizaos/core";
import { logger } from "@elizaos/core";

// Use unknown type to avoid version mismatch issues between @elizaos/core versions
type DatabaseAdapter = unknown;

export interface DirectDatabaseConfig {
  postgresUrl: string;
}

/**
 * Creates a database adapter from a direct PostgreSQL connection URL.
 *
 * @param config - Configuration with postgresUrl
 * @param agentId - UUID of the agent
 * @returns Database adapter or null if plugin-sql is not available
 */
export async function createDirectDatabaseAdapter(
  config: DirectDatabaseConfig,
  agentId: UUID,
): Promise<DatabaseAdapter | null> {
  try {
    // Dynamic import to avoid bundling issues
    const pluginSql = await import("@elizaos/plugin-sql");

    if (!pluginSql.createDatabaseAdapter) {
      logger.error(
        { src: "plugin:elizacloud" },
        "@elizaos/plugin-sql does not export createDatabaseAdapter",
      );
      return null;
    }

    const adapter = pluginSql.createDatabaseAdapter(
      { postgresUrl: config.postgresUrl },
      agentId,
    );

    logger.info(
      { src: "plugin:elizacloud", agentId },
      "Direct database adapter created",
    );

    return adapter;
  } catch (importError) {
    logger.error(
      { src: "plugin:elizacloud" },
      "Direct database requires @elizaos/plugin-sql. Install it with: bun add @elizaos/plugin-sql",
    );
    logger.debug(
      { src: "plugin:elizacloud", error: importError },
      "Import error details",
    );
    return null;
  }
}
