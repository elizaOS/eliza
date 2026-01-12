/**
 * Cloud Database Adapter
 *
 * Connects to ElizaOS Cloud's managed PostgreSQL database.
 * This adapter requests a database connection URL from the cloud service
 * and uses the standard PostgreSQL adapter from plugin-sql.
 */

import type { UUID, IDatabaseAdapter } from "@elizaos/core";
import { logger } from "@elizaos/core";
import pluginSql from "@elizaos/plugin-sql/node";
import type { CloudDatabaseConfig, DatabaseProvisionResponse } from "./types";

const DEFAULT_CLOUD_URL = "https://www.elizacloud.ai";

/**
 * Creates a cloud database adapter that connects to ElizaOS Cloud's managed database.
 *
 * @param config - Cloud database configuration
 * @returns Database adapter or null if cloud database is not available
 */
export async function createCloudDatabaseAdapter(
  config: CloudDatabaseConfig,
): Promise<IDatabaseAdapter | null> {
  const baseUrl = config.baseUrl || DEFAULT_CLOUD_URL;

  logger.info(
    { src: "plugin:elizacloud", agentId: config.agentId },
    "Provisioning cloud database",
  );

  // Request database connection from cloud service
  const response = await provisionCloudDatabase(
    config.apiKey,
    baseUrl,
    config.agentId,
  );

  if (!response.success || !response.connectionUrl) {
    logger.error(
      {
        src: "plugin:elizacloud",
        error: response.error,
        agentId: config.agentId,
      },
      "Failed to provision cloud database",
    );
    return null;
  }

  logger.info(
    { src: "plugin:elizacloud", agentId: config.agentId },
    "Cloud database provisioned successfully",
  );

  const adapter = pluginSql.createDatabaseAdapter(
    { postgresUrl: response.connectionUrl },
    config.agentId as UUID,
  );

  logger.info(
    { src: "plugin:elizacloud", agentId: config.agentId },
    "Cloud database adapter created using PostgreSQL connection",
  );

  return adapter;
}

/**
 * Request a database connection from ElizaOS Cloud
 */
async function provisionCloudDatabase(
  apiKey: string,
  baseUrl: string,
  agentId: string,
): Promise<DatabaseProvisionResponse> {
  try {
    const response = await fetch(`${baseUrl}/api/v1/database/provision`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        agentId,
        type: "postgresql",
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return {
        success: false,
        error: `Cloud database provisioning failed: ${response.status} ${errorText}`,
      };
    }

    const data = await response.json();
    return {
      success: true,
      connectionUrl: data.connectionUrl,
      expiresAt: data.expiresAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: `Network error during database provisioning: ${message}`,
    };
  }
}

/**
 * Cloud Database Adapter class
 * Wraps the provisioning logic for use in plugin initialization
 */
export class CloudDatabaseAdapter {
  private config: CloudDatabaseConfig;
  private adapter: IDatabaseAdapter | null = null;

  constructor(config: CloudDatabaseConfig) {
    this.config = config;
  }

  async initialize(): Promise<IDatabaseAdapter | null> {
    if (this.adapter) {
      return this.adapter;
    }

    this.adapter = await createCloudDatabaseAdapter(this.config);
    return this.adapter;
  }

  getAdapter(): IDatabaseAdapter | null {
    return this.adapter;
  }
}
