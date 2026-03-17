import { logger, type Plugin } from "@elizaos/core";
import { RuntimeMigrator } from "./runtime-migrator";
import type { DrizzleDatabase } from "./types";

export class DatabaseMigrationService {
  private db: DrizzleDatabase | null = null;
  private registeredSchemas = new Map<string, Record<string, unknown>>();
  private migrator: RuntimeMigrator | null = null;

  async initializeWithDatabase(db: DrizzleDatabase): Promise<void> {
    this.db = db;

    // MySQL has no RLS, skip entity RLS migration

    try {
      this.migrator = new RuntimeMigrator(db);
      await this.migrator.initialize();
    } catch (error) {
      logger.warn(
        { src: "plugin:mysql", error: error instanceof Error ? error.message : String(error) },
        "RuntimeMigrator initialization failed, using simple migration mode"
      );
    }

    logger.info({ src: "plugin:mysql" }, "DatabaseMigrationService initialized");
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
        src: "plugin:mysql",
        schemasDiscovered: this.registeredSchemas.size,
        totalPlugins: plugins.length,
      },
      "Plugin schemas discovered"
    );
  }

  registerSchema(pluginName: string, schema: Record<string, unknown>): void {
    this.registeredSchemas.set(pluginName, schema);
    logger.debug({ src: "plugin:mysql", pluginName }, "Schema registered");
  }

  async runAllPluginMigrations(options?: {
    verbose?: boolean;
    force?: boolean;
    dryRun?: boolean;
  }): Promise<void> {
    if (!this.db) {
      throw new Error("Database not initialized in DatabaseMigrationService");
    }

    if (!this.migrator) {
      logger.info(
        { src: "plugin:mysql" },
        "RuntimeMigrator not available - skipping plugin migrations"
      );
      return;
    }

    const isProduction = process.env.NODE_ENV === "production";

    const migrationOptions = {
      verbose: options?.verbose ?? !isProduction,
      force: options?.force ?? false,
      dryRun: options?.dryRun ?? false,
    };

    logger.info(
      {
        src: "plugin:mysql",
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
        logger.info({ src: "plugin:mysql", pluginName }, "Migration completed");
      } catch (error) {
        failureCount++;
        const errorMessage = (error as Error).message;

        errors.push({ pluginName, error: error as Error });

        if (errorMessage.includes("Destructive migration blocked")) {
          logger.error(
            { src: "plugin:mysql", pluginName },
            "Migration blocked - destructive changes detected. Set ELIZA_ALLOW_DESTRUCTIVE_MIGRATIONS=true or use force option"
          );
        } else {
          logger.error(
            { src: "plugin:mysql", pluginName, error: errorMessage },
            "Migration failed"
          );
        }
      }
    }

    if (failureCount === 0) {
      logger.info({ src: "plugin:mysql", successCount }, "All migrations completed successfully");
      // MySQL has no RLS, skip RLS re-application
    } else {
      logger.error({ src: "plugin:mysql", failureCount, successCount }, "Some migrations failed");

      const errorSummary = errors.map((e) => `${e.pluginName}: ${e.error.message}`).join("\n  ");
      throw new Error(`${failureCount} migration(s) failed:\n  ${errorSummary}`);
    }
  }

  getMigrator(): RuntimeMigrator | null {
    return this.migrator;
  }
}
