/**
 * User Database Service
 *
 * High-level business logic for managing user app databases.
 * Coordinates between Neon API and our apps database.
 */

import { appsRepository } from "@/db/repositories/apps";
import type { App, UserDatabaseStatus } from "@/db/schemas/apps";
import { logger } from "@/lib/utils/logger";
import { fieldEncryption } from "./field-encryption";
import { getNeonClient } from "./neon-client";

/**
 * Result from provisioning a user database.
 */
export interface ProvisionResult {
  /** Whether provisioning succeeded */
  success: boolean;

  /** Connection URI (only if success=true) */
  connectionUri?: string;

  /** Neon project ID (only if success=true) */
  projectId?: string;

  /** Neon branch ID (only if success=true) */
  branchId?: string;

  /** AWS region where database was created */
  region?: string;

  /** Error message (only if success=false) */
  error?: string;

  /** Error code for programmatic handling */
  errorCode?: "RATE_LIMITED" | "QUOTA_EXCEEDED" | "API_ERROR" | "UNKNOWN";
}

/**
 * Database status information for an app.
 */
export interface DatabaseStatus {
  /** Whether a database exists for this app */
  hasDatabase: boolean;

  /** Current status */
  status: UserDatabaseStatus;

  /** AWS region (if database exists) */
  region?: string;

  /** Error message (if status is "error") */
  error?: string;

  /** Connection URI (only returned for authorized callers) */
  connectionUri?: string;
}

export class UserDatabaseService {
  /**
   * Provision a database for an app.
   *
   * Uses the shared cloud DATABASE_URL instead of creating per-app Neon
   * projects. ElizaOS plugin-sql tables scope data by agent/app UUID so
   * multiple apps safely coexist. This avoids Neon project/branch limits
   * (BRANCHES_LIMIT_EXCEEDED).
   *
   * Legacy per-app Neon projects with existing neon_project_id still get
   * their credentials returned correctly.
   *
   * @param appId App ID
   * @param appName App name (used for logging)
   * @param region Optional AWS region (ignored in shared-DB mode)
   * @returns Provision result with connection URI
   */
  async provisionDatabase(
    appId: string,
    appName: string,
    region = "aws-us-east-1",
  ): Promise<ProvisionResult> {
    logger.info("Provisioning database for app", { appId, appName, region });

    // Check current status
    const app = await appsRepository.findById(appId);
    if (!app) {
      return {
        success: false,
        error: "App not found",
        errorCode: "UNKNOWN",
      };
    }

    // Already has a database?
    if (app.user_database_status === "ready" && app.user_database_uri) {
      logger.info("App already has database", { appId });
      const decryptedUri = await fieldEncryption.decryptIfNeeded(app.user_database_uri);
      return {
        success: true,
        connectionUri: decryptedUri || undefined,
        projectId: app.user_database_project_id || undefined,
        branchId: app.user_database_branch_id || undefined,
        region: app.user_database_region || region,
      };
    }

    // Atomically try to set status to "provisioning"
    // This prevents race conditions - only one request can win
    const updatedApp = await appsRepository.trySetDatabaseProvisioning(appId, region);

    if (!updatedApp) {
      // Another request won the race, or status was already "provisioning" or "ready"
      // Re-fetch to get current state
      const currentApp = await appsRepository.findById(appId);
      if (currentApp?.user_database_status === "ready" && currentApp.user_database_uri) {
        logger.info("Database was provisioned by concurrent request", {
          appId,
        });
        const decryptedUri = await fieldEncryption.decryptIfNeeded(currentApp.user_database_uri);
        return {
          success: true,
          connectionUri: decryptedUri || undefined,
          projectId: currentApp.user_database_project_id || undefined,
          branchId: currentApp.user_database_branch_id || undefined,
          region: currentApp.user_database_region || region,
        };
      }

      logger.warn("Database provisioning already in progress (lost race)", {
        appId,
      });
      return {
        success: false,
        error: "Database provisioning already in progress",
        errorCode: "UNKNOWN",
      };
    }

    try {
      // Use shared cloud DATABASE_URL instead of per-app Neon projects.
      // ElizaOS plugin-sql tables scope data by agent/app UUID, so multiple
      // apps safely coexist. This avoids BRANCHES_LIMIT_EXCEEDED errors.
      const sharedDbUrl = process.env.DATABASE_URL;
      if (!sharedDbUrl) {
        throw new Error("DATABASE_URL not configured in cloud environment");
      }

      // Encrypt the connection URI before storing
      const encryptedUri = await fieldEncryption.encrypt(app.organization_id, sharedDbUrl);

      await appsRepository.update(appId, {
        user_database_uri: encryptedUri,
        user_database_status: "ready",
        user_database_error: null,
      });

      logger.info("Database provisioned successfully (shared DB)", { appId });

      return {
        success: true,
        connectionUri: sharedDbUrl,
        region,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      logger.error("Database provisioning failed", {
        appId,
        error: errorMessage,
      });

      await appsRepository.update(appId, {
        user_database_status: "error",
        user_database_error: errorMessage,
      });

      return {
        success: false,
        error: errorMessage,
        errorCode: "UNKNOWN",
      };
    }
  }

  /**
   * Clean up database when app is deleted.
   *
   * @param appId App ID
   */
  async cleanupDatabase(appId: string): Promise<void> {
    logger.info("Cleaning up database for app", { appId });

    const app = await appsRepository.findById(appId);
    if (!app || !app.user_database_project_id) {
      logger.debug("No database to clean up", { appId });
      return;
    }

    try {
      const neonClient = getNeonClient();
      await neonClient.deleteProject(app.user_database_project_id);
      logger.info("Database cleaned up successfully", {
        appId,
        projectId: app.user_database_project_id,
      });
    } catch (error) {
      // Log but don't fail - database might already be deleted
      logger.warn("Failed to delete Neon project (may already be deleted)", {
        appId,
        projectId: app.user_database_project_id,
        error: error instanceof Error ? error.message : "Unknown",
      });
    }
  }

  /**
   * Get connection URI for an app.
   *
   * @param appId App ID
   * @returns Decrypted connection URI or null if no database
   */
  async getConnectionUri(appId: string): Promise<string | null> {
    const app = await appsRepository.findById(appId);

    if (!app || app.user_database_status !== "ready" || !app.user_database_uri) {
      return null;
    }

    return fieldEncryption.decryptIfNeeded(app.user_database_uri);
  }

  /**
   * Get database status for an app.
   *
   * @param appId App ID
   * @param includeUri Whether to include connection URI (requires authorization)
   * @returns Database status
   */
  async getStatus(appId: string, includeUri = false): Promise<DatabaseStatus> {
    const app = await appsRepository.findById(appId);

    if (!app) {
      return {
        hasDatabase: false,
        status: "none",
      };
    }

    const status: DatabaseStatus = {
      hasDatabase: app.user_database_status === "ready",
      status: app.user_database_status as UserDatabaseStatus,
      region: app.user_database_region || undefined,
      error: app.user_database_error || undefined,
    };

    if (includeUri && app.user_database_uri) {
      status.connectionUri =
        (await fieldEncryption.decryptIfNeeded(app.user_database_uri)) || undefined;
    }

    return status;
  }

  /**
   * Retry provisioning for an app that previously failed.
   *
   * @param appId App ID
   * @param appName App name (used for Neon project name)
   * @param region Optional AWS region
   * @returns Provision result
   */
  async retryProvisioning(
    appId: string,
    appName: string,
    region?: string,
  ): Promise<ProvisionResult> {
    const app = await appsRepository.findById(appId);

    if (!app) {
      return {
        success: false,
        error: "App not found",
        errorCode: "UNKNOWN",
      };
    }

    // Only retry if in error state
    if (app.user_database_status !== "error") {
      if (app.user_database_status === "ready") {
        const decryptedUri = await fieldEncryption.decryptIfNeeded(app.user_database_uri);
        return {
          success: true,
          connectionUri: decryptedUri || undefined,
          projectId: app.user_database_project_id || undefined,
          branchId: app.user_database_branch_id || undefined,
          region: app.user_database_region || region,
        };
      }

      return {
        success: false,
        error: `Cannot retry provisioning: current status is "${app.user_database_status}"`,
        errorCode: "UNKNOWN",
      };
    }

    // Clear error and retry
    await appsRepository.update(appId, {
      user_database_status: "none",
      user_database_error: null,
    });

    return this.provisionDatabase(
      appId,
      appName,
      region || app.user_database_region || "aws-us-east-1",
    );
  }
}

// Singleton export
export const userDatabaseService = new UserDatabaseService();

/**
 * Get decrypted database connection URI for an app.
 *
 * This helper handles both encrypted (enc:v1:...) and legacy plaintext URIs
 * for backward compatibility during migration.
 *
 * @param app - The app object with user_database_uri field
 * @returns Decrypted connection URI or null if no database
 */
export async function getDecryptedDatabaseUri(app: App): Promise<string | null> {
  if (!app.user_database_uri) {
    return null;
  }
  return fieldEncryption.decryptIfNeeded(app.user_database_uri);
}
