/**
 * `DatabaseMigrationService` orchestrates startup schema migration for every
 * registered plugin: collects each plugin's `schema` export, runs the
 * legacy entity-RLS backfill (`migrateToEntityRLS`), drives `RuntimeMigrator`
 * per plugin (continuing past individual failures and aggregating them into
 * one error), and — when `ENABLE_DATA_ISOLATION=true` — re-applies Row Level
 * Security across all tables once every migration succeeds.
 */
import { type IDatabaseAdapter, logger, type Plugin } from "@elizaos/core";
import { applyMessageSearchObjects } from "./message-search";
import { migrateToEntityRLS } from "./migrations";
import { applyEntityRLSToAllTables, applyRLSToNewTables, installRLSFunctions } from "./rls";
import { RuntimeMigrator } from "./runtime-migrator";
import type { DrizzleDatabase } from "./types";

const MESSAGE_SEARCH_OBJECTS_ENV = "ELIZA_APPLY_MESSAGE_SEARCH_OBJECTS";

export type DatabaseBackend = "postgres" | "pglite" | "unknown";

interface DatabaseMigrationServiceOptions {
  databaseBackend?: DatabaseBackend;
}

function shouldApplyMessageSearchObjects(databaseBackend: DatabaseBackend): boolean {
  const setting = process.env[MESSAGE_SEARCH_OBJECTS_ENV]?.toLowerCase();
  if (setting === "false" || setting === "0") {
    return false;
  }
  if (setting === "true" || setting === "1") {
    return true;
  }

  return !(process.env.NODE_ENV === "production" && databaseBackend === "postgres");
}

export class DatabaseMigrationService {
  private db: DrizzleDatabase | null = null;
  private registeredSchemas = new Map<string, Record<string, unknown>>();
  private migrator: RuntimeMigrator | null = null;
  private readonly databaseBackend: DatabaseBackend;

  constructor(options: DatabaseMigrationServiceOptions = {}) {
    this.databaseBackend = options.databaseBackend ?? "unknown";
  }

  async initializeWithDatabase(db: DrizzleDatabase): Promise<void> {
    this.db = db;

    interface AdapterWrapper extends IDatabaseAdapter {
      db: DrizzleDatabase;
    }
    const adapterWrapper: AdapterWrapper = { db } as AdapterWrapper;
    await migrateToEntityRLS(adapterWrapper);

    this.migrator = new RuntimeMigrator(db);
    await this.migrator.initialize();
    logger.info({ src: "plugin:sql" }, "DatabaseMigrationService initialized");
  }

  discoverAndRegisterPluginSchemas(plugins: Plugin[]): void {
    for (const plugin of plugins) {
      type PluginWithSchema = Plugin & {
        schema?: Record<string, unknown>;
      };
      const pluginWithSchema = plugin as PluginWithSchema;
      if (pluginWithSchema.schema) {
        this.registeredSchemas.set(plugin.name, pluginWithSchema.schema);
      }
    }
    logger.info(
      {
        src: "plugin:sql",
        schemasDiscovered: this.registeredSchemas.size,
        totalPlugins: plugins.length,
      },
      "Plugin schemas discovered"
    );
  }

  registerSchema(pluginName: string, schema: Record<string, unknown>): void {
    this.registeredSchemas.set(pluginName, schema);
    logger.debug({ src: "plugin:sql", pluginName }, "Schema registered");
  }

  async runAllPluginMigrations(options?: {
    verbose?: boolean;
    force?: boolean;
    dryRun?: boolean;
  }): Promise<void> {
    if (!this.db || !this.migrator) {
      throw new Error("Database or migrator not initialized in DatabaseMigrationService");
    }

    const isProduction = process.env.NODE_ENV === "production";

    const migrationOptions = {
      verbose: options?.verbose ?? !isProduction,
      force: options?.force ?? false,
      dryRun: options?.dryRun ?? false,
    };

    logger.info(
      {
        src: "plugin:sql",
        environment: isProduction ? "PRODUCTION" : "DEVELOPMENT",
        pluginCount: this.registeredSchemas.size,
        dryRun: migrationOptions.dryRun,
      },
      "Starting migrations"
    );

    let successCount = 0;
    let failureCount = 0;
    const errors: Array<{ pluginName: string; error: Error }> = [];

    for (const [pluginName, schema] of this.registeredSchemas) {
      try {
        await this.migrator.migrate(pluginName, schema, migrationOptions);
        successCount++;
        logger.info({ src: "plugin:sql", pluginName }, "Migration completed");
      } catch (error) {
        failureCount++;
        const errorMessage = (error as Error).message;

        errors.push({ pluginName, error: error as Error });

        if (errorMessage.includes("Destructive migration blocked")) {
          logger.error(
            { src: "plugin:sql", pluginName },
            "Migration blocked - destructive changes detected. Set ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true or use force option"
          );
        } else {
          logger.error({ src: "plugin:sql", pluginName, error: errorMessage }, "Migration failed");
        }
      }
    }

    if (failureCount === 0) {
      logger.info({ src: "plugin:sql", successCount }, "All migrations completed successfully");

      // Install the message full-text/trigram search objects on the migrated
      // `memories` table (#13534). Idempotent; runs after the table exists so the
      // GIN expression indexes can be created.
      if (shouldApplyMessageSearchObjects(this.databaseBackend)) {
        await applyMessageSearchObjects(this.db);
      } else {
        logger.warn(
          {
            src: "plugin:sql",
            env: MESSAGE_SEARCH_OBJECTS_ENV,
            databaseBackend: this.databaseBackend,
          },
          "[MessageSearch] skipping automatic search-object install in production Postgres; set ELIZA_APPLY_MESSAGE_SEARCH_OBJECTS=true after scheduling the generated-column/index DDL"
        );
      }

      const dataIsolationEnabled = process.env.ENABLE_DATA_ISOLATION === "true";

      if (dataIsolationEnabled) {
        try {
          logger.info({ src: "plugin:sql" }, "Re-applying Row Level Security...");
          interface AdapterWrapper extends IDatabaseAdapter {
            db: DrizzleDatabase;
          }
          const adapterWrapper: AdapterWrapper = {
            db: this.db,
          } as AdapterWrapper;
          await installRLSFunctions(adapterWrapper);
          await applyRLSToNewTables(adapterWrapper);
          await applyEntityRLSToAllTables(adapterWrapper);
          logger.info({ src: "plugin:sql" }, "RLS re-applied successfully");
        } catch (rlsError) {
          const errorMsg = rlsError instanceof Error ? rlsError.message : String(rlsError);
          logger.warn(
            { src: "plugin:sql", error: errorMsg },
            "Failed to re-apply RLS (expected while schemas are still missing server_id columns)"
          );
        }
      } else {
        logger.info(
          { src: "plugin:sql" },
          "Skipping RLS re-application (ENABLE_DATA_ISOLATION is not true)"
        );
      }
    } else {
      logger.error({ src: "plugin:sql", failureCount, successCount }, "Some migrations failed");

      const errorSummary = errors.map((e) => `${e.pluginName}: ${e.error.message}`).join("\n  ");
      const aggregateError = new Error(`${failureCount} migration(s) failed:\n  ${errorSummary}`, {
        cause: errors[0]?.error,
      }) as Error & {
        migrationErrors?: Array<{ pluginName: string; error: Error }>;
      };
      aggregateError.migrationErrors = errors;
      throw aggregateError;
    }
  }

  getMigrator(): RuntimeMigrator | null {
    return this.migrator;
  }
}
