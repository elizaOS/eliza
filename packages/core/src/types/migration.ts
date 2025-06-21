import type { IAgentRuntime } from './runtime';
import type { Plugin } from './plugin';
import type { UUID } from './primitives';

/**
 * Represents a migration history entry
 */
export interface MigrationHistory {
  id: UUID;
  pluginName: string;
  version: string;
  executedAt: Date;
  success: boolean;
  error?: string;
}

/**
 * Migration configuration options
 */
export interface MigrationConfig {
  /** Whether to run migrations automatically on startup */
  autoRun?: boolean;
  /** Whether to track migration history */
  trackHistory?: boolean;
  /** Maximum number of retries for failed migrations */
  maxRetries?: number;
  /** Delay between retries in milliseconds */
  retryDelay?: number;
}

/**
 * Interface for migration services
 */
export interface IMigrationService {
  /** The unique name of this migration service */
  readonly serviceName: string;
  /** The service type identifier */
  readonly serviceType: string;
  
  /**
   * Run all pending migrations
   * @param runtime The agent runtime
   * @returns Promise that resolves when migrations are complete
   */
  runMigrations(runtime: IAgentRuntime): Promise<void>;
  
  /**
   * Get migration history
   * @param pluginName Optional plugin name to filter by
   * @returns Promise resolving to migration history entries
   */
  getMigrationHistory(pluginName?: string): Promise<MigrationHistory[]>;
  
  /**
   * Rollback migrations
   * @param version Optional version to rollback to
   * @returns Promise that resolves when rollback is complete
   */
  rollback(version?: string): Promise<void>;
  
  /**
   * Register a plugin schema for migration
   * @param pluginName The name of the plugin
   * @param schema The schema definition
   */
  registerPluginSchema(pluginName: string, schema: any): void;
  
  /**
   * Check if a plugin has migrations
   * @param pluginName The name of the plugin
   * @returns True if the plugin has migrations
   */
  hasPluginMigrations(pluginName: string): boolean;
  
  /**
   * Get the current version of a plugin's schema
   * @param pluginName The name of the plugin
   * @returns The current version or null if not found
   */
  getPluginVersion(pluginName: string): Promise<string | null>;
}

/**
 * Migration step definition
 */
export interface MigrationStep {
  /** Unique identifier for this migration */
  id: string;
  /** Description of what this migration does */
  description: string;
  /** The actual migration function */
  up: () => Promise<void>;
  /** Optional rollback function */
  down?: () => Promise<void>;
}

/**
 * Plugin migration definition
 */
export interface PluginMigration {
  /** The plugin name */
  pluginName: string;
  /** The target version */
  version: string;
  /** Migration steps */
  steps: MigrationStep[];
}