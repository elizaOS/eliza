import { logger, Service } from '@elizaos/core';
import dotenv from 'dotenv';
import path from 'path';
import type { IAgentRuntime } from '@elizaos/core';
import type { z } from 'zod';

/**
 * Service for centralizing access to configuration values.
 * This allows for a single point of access for all environment variables
 * and ensures proper .env file loading throughout the codebase.
 */
export class ConfigService extends Service {
  static serviceType = 'PolygonConfigService';

  // Required abstract property from Service class
  capabilityDescription = 'Provides configuration management for Polygon plugin';

  private configValues: Map<string, any> = new Map();
  private envLoaded = false;

  constructor(runtime: IAgentRuntime) {
    super(runtime);
    this.loadEnv();
  }

  /**
   * Static start method required by Service
   */
  static async start(runtime: IAgentRuntime): Promise<ConfigService> {
    return new ConfigService(runtime);
  }

  /**
   * Required stop method from Service abstract class
   */
  async stop(): Promise<void> {
    // Nothing to clean up
    return Promise.resolve();
  }

  /**
   * Load environment variables from .env file
   */
  private loadEnv(): void {
    try {
      // Try to load from the root directory first
      const workspaceRoot = path.resolve(__dirname, '../../../..');
      const rootEnvPath = path.resolve(workspaceRoot, '.env');

      // Then from the package directory
      const packageRoot = path.resolve(__dirname, '../..');
      const packageEnvPath = path.resolve(packageRoot, '.env');

      // Try the root .env first
      let result = dotenv.config({ path: rootEnvPath });
      if (result.error) {
        logger.warn(`Could not load .env from root: ${rootEnvPath}. Trying package .env...`);
        // Try the package .env next
        result = dotenv.config({ path: packageEnvPath });
        if (result.error) {
          logger.warn(
            `Could not load .env from package: ${packageEnvPath}. Using existing environment variables.`
          );
        } else {
          logger.info(`Loaded .env from package: ${packageEnvPath}`);
          this.envLoaded = true;
        }
      } else {
        logger.info(`Loaded .env from root: ${rootEnvPath}`);
        this.envLoaded = true;
      }
    } catch (error) {
      logger.error('Error loading .env file:', error);
    }
  }

  /**
   * Get a configuration value, either from runtime settings, environment variables,
   * or the default value provided.
   */
  get<T>(key: string, defaultValue?: T): T {
    // Try to get from cached values first
    if (this.configValues.has(key)) {
      return this.configValues.get(key) as T;
    }

    // Try to get from runtime settings
    const runtimeValue = this.runtime.getSetting(key);
    if (runtimeValue !== undefined && runtimeValue !== null) {
      this.configValues.set(key, runtimeValue);
      return runtimeValue as T;
    }

    // Try to get from environment variables
    const envValue = process.env[key];
    if (envValue !== undefined && envValue !== null) {
      this.configValues.set(key, envValue);
      return envValue as unknown as T;
    }

    // Return default value if provided
    if (defaultValue !== undefined) {
      this.configValues.set(key, defaultValue);
      return defaultValue;
    }

    // Return null if nothing found
    return null as unknown as T;
  }

  /**
   * Get a required configuration value. Throws an error if not found.
   */
  getRequired<T>(key: string): T {
    const value = this.get<T>(key);
    if (value === undefined || value === null) {
      throw new Error(`Required configuration value not found: ${key}`);
    }
    return value;
  }

  /**
   * Clear the cached configuration values
   */
  clearCache(): void {
    this.configValues.clear();
  }

  /**
   * Get all configuration values relevant to Polygon plugin
   */
  getPolygonConfig() {
    return {
      polygonRpcUrl: this.get<string>('POLYGON_RPC_URL'),
      polygonRpcUrlFallback: this.get<string>('POLYGON_RPC_URL_FALLBACK'),
      ethereumRpcUrl: this.get<string>('ETHEREUM_RPC_URL'),
      ethereumRpcUrlFallback: this.get<string>('ETHEREUM_RPC_URL_FALLBACK'),
      privateKey: this.get<string>('PRIVATE_KEY'),
      polygonscanKey: this.get<string>('POLYGONSCAN_KEY'),
      polygonscanKeyFallback: this.get<string>('POLYGONSCAN_KEY_FALLBACK'),
      heimdallRpcUrl: this.get<string>('HEIMDALL_RPC_URL'),
      governorAddress: this.get<string>('GOVERNOR_ADDRESS'),
      tokenAddress: this.get<string>('TOKEN_ADDRESS'),
      timelockAddress: this.get<string>('TIMELOCK_ADDRESS'),
      polygonPluginsEnabled: this.get<boolean>('POLYGON_PLUGINS_ENABLED', true),
    };
  }

  /**
   * Validate the configuration using a Zod schema
   */
  async validateConfig<T>(schema: z.ZodSchema<T>): Promise<T> {
    const config = this.getPolygonConfig();
    return await schema.parseAsync(config);
  }
}

export default ConfigService;
