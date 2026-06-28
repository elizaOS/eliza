/**
 * User Database Service
 *
 * High-level business logic for managing user app databases. Provisions either
 * an isolated per-tenant database (when a tenant-DB backend is wired) or the
 * shared cloud DATABASE_URL, and coordinates teardown on app delete.
 */

import { appDatabasesRepository } from "../../db/repositories/app-databases";
import { appsRepository } from "../../db/repositories/apps";
import type { App, UserDatabaseStatus } from "../../db/schemas/apps";
import { logger } from "../utils/logger";
import { fieldEncryption } from "./field-encryption";
import type { TenantDbProvisioning } from "./tenant-db/tenant-db-provisioning";

/**
 * Result from provisioning a user database.
 */
export interface ProvisionResult {
  /** Whether provisioning succeeded */
  success: boolean;

  /** Connection URI (only if success=true) */
  connectionUri?: string;

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

/**
 * Worker-side enqueuer that hands an isolated tenant-DB teardown to the daemon
 * (the DROP needs `pg`, which doesn't load on workerd). Injected at cloud-api
 * boot via {@link UserDatabaseService.setDeprovisionEnqueuer}; carries the app's
 * *encrypted* DSN so the job survives the app row's cascade-delete (#8342).
 */
export type IsolatedDbDeprovisionEnqueuer = (p: {
  appId: string;
  dbUri: string;
  organizationId: string;
  userId?: string;
}) => Promise<unknown>;

export class UserDatabaseService {
  private readonly tenantDbProvisioning?: TenantDbProvisioning;
  private deprovisionEnqueuer?: IsolatedDbDeprovisionEnqueuer;

  /**
   * @param tenantDbProvisioning When provided, apps get a fully ISOLATED
   *   per-tenant database (own DB + role + REVOKE-CONNECT boundary). When
   *   omitted, falls back to the legacy shared cloud DATABASE_URL. The real
   *   isolated backend is injected once its cluster store + Postgres executor
   *   are wired (Apps / Product 2).
   */
  constructor(tenantDbProvisioning?: TenantDbProvisioning) {
    this.tenantDbProvisioning = tenantDbProvisioning;
  }

  /**
   * Wire the Worker-side enqueuer that hands isolated tenant-DB teardown to the
   * daemon. Used when this instance has no local `pg` backend (the cloud-api
   * Worker): {@link cleanupDatabase} enqueues an APP_DB_DEPROVISION job instead
   * of silently no-opping the DROP. No-op on the daemon, which DROPs inline.
   */
  setDeprovisionEnqueuer(enqueuer: IsolatedDbDeprovisionEnqueuer): void {
    this.deprovisionEnqueuer = enqueuer;
  }

  /**
   * Provision an ISOLATED per-tenant database for an app.
   *
   * Called only for `databaseMode: "isolated"` apps. Requires a tenant-DB
   * provisioning backend (the node daemon's real CREATE ROLE / REVOKE CONNECT).
   * If no backend is wired this FAILS CLOSED (throws → ProvisionResult.success
   * false) instead of silently falling back to the shared cloud DATABASE_URL —
   * a degrade that would co-locate the app on the shared DB while reporting it as
   * isolated.
   *
   * @param appId App ID
   * @param appName App name (used for logging)
   * @param region Optional AWS region for the provisioned tenant DB
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

    const database = await appDatabasesRepository.findStateByAppId(appId);

    // Already has a database?
    if (database?.user_database_status === "ready" && database.user_database_uri) {
      logger.info("App already has database", { appId });
      const decryptedUri = await fieldEncryption.decryptIfNeeded(database.user_database_uri);
      return {
        success: true,
        connectionUri: decryptedUri || undefined,
        region: database.user_database_region || region,
      };
    }

    // Atomically try to set status to "provisioning"
    // This prevents race conditions - only one request can win
    const updatedDatabase = await appDatabasesRepository.trySetProvisioning(appId, region);

    if (!updatedDatabase) {
      // Another request won the race, or status was already "provisioning" or "ready"
      // Re-fetch to get current state
      const currentDatabase = await appDatabasesRepository.findStateByAppIdForWrite(appId);
      if (currentDatabase?.user_database_status === "ready" && currentDatabase.user_database_uri) {
        logger.info("Database was provisioned by concurrent request", {
          appId,
        });
        const decryptedUri = await fieldEncryption.decryptIfNeeded(
          currentDatabase.user_database_uri,
        );
        return {
          success: true,
          connectionUri: decryptedUri || undefined,
          region: currentDatabase.user_database_region || region,
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
      // Per-tenant ISOLATED database (Apps / Product 2): provision the app its
      // own DB + role (real CREATE ROLE / REVOKE CONNECT) and store that DSN.
      // This requires a tenant-DB provisioning backend (the node daemon); with
      // none wired we FAIL CLOSED rather than silently using the shared cloud
      // DATABASE_URL — see the else branch.
      let connectionUri: string;
      let clusterId: string | undefined;
      if (this.tenantDbProvisioning) {
        const provisioned = await this.tenantDbProvisioning.provisionForApp(appId);
        connectionUri = provisioned.dsn;
        clusterId = provisioned.clusterId;
      } else {
        // FAIL CLOSED. provisionDatabase is only called for mode==="isolated"
        // apps; with no provisioning backend we'd silently co-locate the app on
        // the shared cloud DATABASE_URL (isolation by UUID only) yet report it as
        // isolated. Never silently degrade isolation — throw so the deploy fails
        // loudly. The live path runs this in the node daemon (backend wired); an
        // unarmed daemon must hard-fail, not downgrade.
        throw new Error(
          "Isolated database requested but no tenant-DB provisioning backend is wired " +
            "(the provisioning daemon is not armed). Refusing to fall back to the shared " +
            "cloud DATABASE_URL — arm the daemon (configureAppsDeployBackend) and retry.",
        );
      }

      // Encrypt the connection URI before storing.
      const encryptedUri = await fieldEncryption.encrypt(app.organization_id, connectionUri);

      await appDatabasesRepository.updateState(appId, {
        user_database_uri: encryptedUri,
        user_database_status: "ready",
        user_database_error: null,
      });

      logger.info("Database provisioned successfully", {
        appId,
        mode: "isolated",
        clusterId,
      });

      return {
        success: true,
        connectionUri,
        region,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      logger.error("Database provisioning failed", {
        appId,
        error: errorMessage,
      });

      await appDatabasesRepository.updateState(appId, {
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
   * @param opts Owning org/user — required to enqueue the daemon-side isolated
   *   DB teardown from the Worker (the job row carries organization_id/user_id).
   */
  async cleanupDatabase(
    appId: string,
    opts?: { organizationId?: string; userId?: string },
  ): Promise<void> {
    logger.info("Cleaning up database for app", { appId });

    const database = await appDatabasesRepository.findStateByAppIdForWrite(appId);
    if (!database) {
      logger.debug("No database to clean up", { appId });
      return;
    }

    // ISOLATED (Apps / Product 2): DROP the app's OWN per-tenant DATABASE + ROLE
    // and release its cluster slot — otherwise we leak a live DB we keep paying
    // for AND burn one of the cluster's finite slots forever (#8342).
    //
    // The DROP needs `pg`, which only loads on the daemon. So:
    //  - Daemon (provisioning backend wired): DROP inline.
    //  - Worker (no backend, but enqueuer wired): enqueue an APP_DB_DEPROVISION
    //    job the daemon runs — carrying the *encrypted* URI so it survives this
    //    app row's cascade-delete. THIS is the live path: the delete route runs
    //    on the Worker.
    const isolatedUri = database.user_database_uri;
    if (isolatedUri) {
      if (this.tenantDbProvisioning) {
        try {
          const dsn = await fieldEncryption.decryptIfNeeded(isolatedUri);
          if (dsn) {
            const result = await this.tenantDbProvisioning.deprovisionForApp(appId, dsn);
            logger.info("Isolated tenant DB deprovisioned", {
              appId,
              deprovisioned: result.deprovisioned,
            });
          }
        } catch (error) {
          // Don't fail the app delete on a teardown hiccup; a reconciler sweeps orphans.
          logger.warn("Failed to deprovision isolated tenant DB", {
            appId,
            error: error instanceof Error ? error.message : "Unknown",
          });
        }
      } else if (this.deprovisionEnqueuer && opts?.organizationId) {
        try {
          await this.deprovisionEnqueuer({
            appId,
            dbUri: isolatedUri,
            organizationId: opts.organizationId,
            userId: opts.userId,
          });
          logger.info("Enqueued isolated tenant DB deprovision job", { appId });
        } catch (error) {
          // Don't fail the app delete on an enqueue hiccup; a reconciler sweeps orphans.
          logger.warn("Failed to enqueue isolated tenant DB deprovision", {
            appId,
            error: error instanceof Error ? error.message : "Unknown",
          });
        }
      } else {
        // No `pg` backend and no enqueuer (or missing org): the DROP can't run
        // here. Surface it loudly so an orphan-DB reconciler can catch it.
        logger.warn("Isolated tenant DB not torn down — no backend/enqueuer wired", {
          appId,
          hasEnqueuer: Boolean(this.deprovisionEnqueuer),
          hasOrg: Boolean(opts?.organizationId),
        });
      }
    }
  }

  /**
   * Get connection URI for an app.
   *
   * @param appId App ID
   * @returns Decrypted connection URI or null if no database
   */
  async getConnectionUri(appId: string): Promise<string | null> {
    const database = await appDatabasesRepository.findStateByAppId(appId);

    if (!database || database.user_database_status !== "ready" || !database.user_database_uri) {
      return null;
    }

    return fieldEncryption.decryptIfNeeded(database.user_database_uri);
  }

  /**
   * Get database status for an app.
   *
   * @param appId App ID
   * @param includeUri Whether to include connection URI (requires authorization)
   * @returns Database status
   */
  async getStatus(appId: string, includeUri = false): Promise<DatabaseStatus> {
    const database = await appDatabasesRepository.findStateByAppId(appId);

    if (!database) {
      return {
        hasDatabase: false,
        status: "none",
      };
    }

    const status: DatabaseStatus = {
      hasDatabase: database.user_database_status === "ready",
      status: database.user_database_status as UserDatabaseStatus,
      region: database.user_database_region || undefined,
      error: database.user_database_error || undefined,
    };

    if (includeUri && database.user_database_uri) {
      status.connectionUri =
        (await fieldEncryption.decryptIfNeeded(database.user_database_uri)) || undefined;
    }

    return status;
  }

  /**
   * Retry provisioning for an app that previously failed.
   *
   * @param appId App ID
   * @param appName App name (used for logging)
   * @param region Optional AWS region
   * @returns Provision result
   */
  async retryProvisioning(
    appId: string,
    appName: string,
    region?: string,
  ): Promise<ProvisionResult> {
    const app = await appsRepository.findById(appId);
    const database = await appDatabasesRepository.findStateByAppIdForWrite(appId);

    if (!app) {
      return {
        success: false,
        error: "App not found",
        errorCode: "UNKNOWN",
      };
    }

    // Only retry if in error state
    if (database?.user_database_status !== "error") {
      if (database?.user_database_status === "ready") {
        const decryptedUri = await fieldEncryption.decryptIfNeeded(database.user_database_uri);
        return {
          success: true,
          connectionUri: decryptedUri || undefined,
          region: database.user_database_region || region,
        };
      }

      return {
        success: false,
        error: `Cannot retry provisioning: current status is "${
          database?.user_database_status ?? "none"
        }"`,
        errorCode: "UNKNOWN",
      };
    }

    // Clear error and retry
    await appDatabasesRepository.updateState(appId, {
      user_database_status: "none",
      user_database_error: null,
    });

    return this.provisionDatabase(
      appId,
      appName,
      region || database.user_database_region || "aws-us-east-1",
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
 * @param app - The app object whose canonical database row should be read
 * @returns Decrypted connection URI or null if no database
 */
export async function getDecryptedDatabaseUri(app: Pick<App, "id">): Promise<string | null> {
  const database = await appDatabasesRepository.findStateByAppId(app.id);

  if (!database?.user_database_uri) {
    return null;
  }

  return fieldEncryption.decryptIfNeeded(database.user_database_uri);
}
