import { logger, type Plugin } from '@elizaos/core';
import { runPluginMigrations } from './custom-migrator';
import { EnhancedMigrationService, type EnhancedMigrationOptions } from './enhanced-migration-service';
import type { DrizzleDatabase } from './types';

export class DatabaseMigrationService {
  private db: DrizzleDatabase | null = null;
  private registeredSchemas = new Map<string, any>();
  private enhancedService?: EnhancedMigrationService;
  private useEnhancedMigrations: boolean = true;

  constructor(options?: { useEnhancedMigrations?: boolean }) {
    this.useEnhancedMigrations = options?.useEnhancedMigrations ?? true;
    
    if (this.useEnhancedMigrations) {
      this.enhancedService = new EnhancedMigrationService();
    }
  }

  async initializeWithDatabase(db: DrizzleDatabase): Promise<void> {
    this.db = db;
    
    if (this.enhancedService) {
      await this.enhancedService.initializeWithDatabase(db);
      logger.info('DatabaseMigrationService initialized with enhanced migration capabilities');
    } else {
      logger.info('DatabaseMigrationService initialized with basic migration capabilities');
    }
  }

  discoverAndRegisterPluginSchemas(plugins: Plugin[]): void {
    for (const plugin of plugins) {
      if (plugin.schema) {
        this.registeredSchemas.set(plugin.name, plugin.schema);
        logger.info(`Registered schema for plugin: ${plugin.name}`);
      }
    }
    
    if (this.enhancedService) {
      this.enhancedService.discoverAndRegisterPluginSchemas(plugins);
    }
    
    logger.info(
      `Discovered ${this.registeredSchemas.size} plugin schemas out of ${plugins.length} plugins`
    );
  }

  async runAllPluginMigrations(options?: EnhancedMigrationOptions): Promise<void> {
    if (!this.db) {
      throw new Error('Database not initialized in DatabaseMigrationService');
    }

    if (this.enhancedService && this.useEnhancedMigrations) {
      logger.info('Running enhanced migrations with ALTER support...');
      
      // For initial migrations, use force mode to bypass confirmation requirements
      const enhancedOptions = {
        enableAlterOperations: true,
        force: true,
        recordHistory: true,
        showPlan: false, // Reduce noise
        ...options
      };
      
      const summaries = await this.enhancedService.runAllPluginMigrations(enhancedOptions);
      
      // Log summary
      const successful = summaries.filter(s => s.success).length;
      const failed = summaries.filter(s => !s.success).length;
      
      if (failed === 0) {
        logger.info(`✅ All ${successful} plugin migrations completed successfully`);
      } else {
        logger.warn(`⚠️  ${successful} migrations successful, ${failed} failed`);
        
        // Log failed migrations
        summaries.filter(s => !s.success).forEach(summary => {
          logger.error(`❌ ${summary.pluginName}: ${summary.warnings.join(', ')}`);
        });
      }
      
      return;
    }

    // Fallback to basic migrations
    logger.info(`Running basic migrations for ${this.registeredSchemas.size} plugins...`);

    for (const [pluginName, schema] of this.registeredSchemas) {
      logger.info(`Starting migration for plugin: ${pluginName}`);

      try {
        await runPluginMigrations(this.db!, pluginName, schema);
        logger.info(`✅ Migration completed for plugin: ${pluginName}`);
      } catch (error) {
        logger.error(`❌ Migration failed for plugin ${pluginName}:`, error);
        throw error; // Re-throw to maintain existing behavior
      }
    }

    logger.info('All plugin migrations completed.');
  }

  /**
   * Runs a dry-run of all migrations to preview changes
   */
  async dryRunMigrations(): Promise<void> {
    if (!this.enhancedService) {
      logger.warn('Dry run is only available with enhanced migrations');
      return;
    }

    logger.info('Running migration dry-run...');
    const summaries = await this.enhancedService.dryRunMigrations();
    
    for (const summary of summaries) {
      if (summary.operationsExecuted > 0) {
        logger.info(`${summary.pluginName}: ${summary.operationsExecuted} operations would be executed`);
      } else {
        logger.info(`${summary.pluginName}: No changes needed`);
      }
      
      if (summary.warnings.length > 0) {
        summary.warnings.forEach(warning => {
          logger.warn(`  ⚠️  ${warning}`);
        });
      }
    }
  }

  /**
   * Rolls back a specific migration
   */
  async rollbackMigration(migrationId: string, force: boolean = false): Promise<boolean> {
    if (!this.enhancedService) {
      logger.error('Rollback is only available with enhanced migrations');
      return false;
    }

    return await this.enhancedService.rollbackMigration(migrationId, { force });
  }

  /**
   * Gets migration history for a plugin
   */
  async getPluginMigrationHistory(pluginName: string, limit: number = 10) {
    if (!this.enhancedService) {
      logger.warn('Migration history is only available with enhanced migrations');
      return [];
    }

    return await this.enhancedService.getPluginMigrationHistory(pluginName, limit);
  }

  /**
   * Gets migration statistics
   */
  async getMigrationStatistics() {
    if (!this.enhancedService) {
      logger.warn('Migration statistics are only available with enhanced migrations');
      return null;
    }

    return await this.enhancedService.getMigrationStatistics();
  }

  /**
   * Cleans up old migration history
   */
  async cleanupMigrationHistory(keepDays: number = 90): Promise<number> {
    if (!this.enhancedService) {
      logger.warn('Migration history cleanup is only available with enhanced migrations');
      return 0;
    }

    return await this.enhancedService.cleanupHistory(keepDays);
  }

  /**
   * Enables or disables enhanced migrations
   */
  setEnhancedMigrations(enabled: boolean): void {
    this.useEnhancedMigrations = enabled;
    
    if (enabled && !this.enhancedService) {
      this.enhancedService = new EnhancedMigrationService();
      if (this.db) {
        this.enhancedService.initializeWithDatabase(this.db);
      }
    }
    
    logger.info(`Enhanced migrations ${enabled ? 'enabled' : 'disabled'}`);
  }
}
