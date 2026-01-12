/**
 * Direct Database Adapter
 *
 * Creates a database adapter from a direct PostgreSQL connection URL.
 * This is used by the ElizaOS Cloud platform itself which already has
 * database access and doesn't need to provision via API.
 *
 * For users who want managed database provisioning, use createCloudDatabaseAdapter instead.
 */

import type { UUID, IDatabaseAdapter } from "@elizaos/core";
import { logger } from "@elizaos/core";
import pluginSql from "@elizaos/plugin-sql/node";

export interface DirectDatabaseConfig {
  postgresUrl: string;
}

/**
 * Creates a database adapter from a direct PostgreSQL connection URL (sync version).
 * This is the primary method for cloud platform use.
 *
 * @param config - Configuration with postgresUrl
 * @param agentId - UUID of the agent
 * @returns Database adapter from plugin-sql
 */
export function createDatabaseAdapter(
  config: DirectDatabaseConfig,
  agentId: UUID,
): IDatabaseAdapter {
  const adapter = pluginSql.createDatabaseAdapter(
    { postgresUrl: config.postgresUrl },
    agentId,
  );

  logger.info(
    { src: "plugin:elizacloud", agentId },
    "Direct database adapter created",
  );

  return adapter;
}

/**
 * Creates a database adapter from a direct PostgreSQL connection URL (async version).
 * Kept for backwards compatibility with existing code.
 *
 * @param config - Configuration with postgresUrl
 * @param agentId - UUID of the agent
 * @returns Database adapter from plugin-sql
 */
export async function createDirectDatabaseAdapter(
  config: DirectDatabaseConfig,
  agentId: UUID,
): Promise<IDatabaseAdapter> {
  return createDatabaseAdapter(config, agentId);
}
