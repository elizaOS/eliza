import { type Plugin } from "@elizaos/core";
import { RuntimeMigrator } from "./runtime-migrator";
import type { DrizzleDatabase } from "./types";
export declare class DatabaseMigrationService {
  private db;
  private registeredSchemas;
  private migrator;
  /**
   * Initialize service with database connection
   * @param db - Drizzle database instance
   */
  initializeWithDatabase(db: DrizzleDatabase): Promise<void>;
  /**
   * Auto-discover and register schemas from plugins
   * @param plugins - Array of plugins to scan for schemas
   */
  discoverAndRegisterPluginSchemas(plugins: Plugin[]): void;
  /**
   * Register a schema for a specific plugin
   * @param pluginName - Plugin identifier
   * @param schema - Drizzle schema object
   */
  registerSchema(pluginName: string, schema: Record<string, unknown>): void;
  /**
   * Run migrations for all registered plugins
   * @param options - Migration options
   * @param options.verbose - Log detailed output (default: true in dev, false in prod)
   * @param options.force - Allow destructive migrations
   * @param options.dryRun - Preview changes without applying
   * @throws Error if any migration fails or destructive changes blocked
   */
  runAllPluginMigrations(options?: {
    verbose?: boolean;
    force?: boolean;
    dryRun?: boolean;
  }): Promise<void>;
  /**
   * Get the runtime migrator instance for advanced operations
   * @returns RuntimeMigrator instance or null if not initialized
   */
  getMigrator(): RuntimeMigrator | null;
}
//# sourceMappingURL=migration-service.d.ts.map
