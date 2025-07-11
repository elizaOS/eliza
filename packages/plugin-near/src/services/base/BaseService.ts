import { Service, type IAgentRuntime, elizaLogger } from '@elizaos/core';
import { NearPluginError, NearErrorCode } from '../../core/errors';
import type { ServiceStatus, NearPluginConfig } from '../../core/types';
import { DEFAULTS } from '../../core/constants';
import { validateNearConfig } from '../../environment';

export abstract class BaseNearService extends Service {
  protected config: NearPluginConfig = {} as NearPluginConfig;
  declare protected runtime: IAgentRuntime; // Initialized in initialize()
  protected lastHealthCheck: number = 0;
  protected isHealthy: boolean = true;
  abstract capabilityDescription: string;

  constructor() {
    super();
  }

  async initialize(runtime: IAgentRuntime): Promise<void> {
    this.runtime = runtime;
    this.config = await validateNearConfig(runtime);
    elizaLogger.info(`Initializing ${this.constructor.name}`);

    try {
      await this.onInitialize();
      elizaLogger.success(`${this.constructor.name} initialized successfully`);
    } catch (error) {
      elizaLogger.error(`Failed to initialize ${this.constructor.name}:`, error);
      throw new NearPluginError(
        NearErrorCode.UNKNOWN_ERROR,
        `Failed to initialize ${this.constructor.name}`,
        error
      );
    }
  }

  /**
   * Service-specific initialization logic
   */
  protected abstract onInitialize(): Promise<void>;

  /**
   * Get service status
   */
  async getStatus(): Promise<ServiceStatus> {
    const now = Date.now();
    const status: ServiceStatus = {
      name: this.constructor.name,
      status: this.isHealthy ? 'online' : 'offline',
      lastCheck: this.lastHealthCheck,
    };

    // Perform health check if needed
    if (now - this.lastHealthCheck > 60000) {
      // Check every minute
      try {
        const startTime = Date.now();
        await this.checkHealth();
        status.latency = Date.now() - startTime;
        status.status = 'online';
        this.isHealthy = true;
      } catch (error) {
        status.status = 'offline';
        status.error = error instanceof Error ? error.message : 'Unknown error';
        this.isHealthy = false;
      }
      this.lastHealthCheck = now;
    }

    return status;
  }

  /**
   * Service-specific health check
   */
  protected abstract checkHealth(): Promise<void>;

  /**
   * Retry an operation with exponential backoff
   */
  protected async retry<T>(
    operation: () => Promise<T>,
    maxRetries: number = DEFAULTS.MAX_RETRIES,
    initialDelay: number = DEFAULTS.RETRY_DELAY
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let i = 0; i < maxRetries; i++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));

        if (i < maxRetries - 1) {
          const delay = initialDelay * Math.pow(2, i);
          elizaLogger.warn(`Retry ${i + 1}/${maxRetries} after ${delay}ms:`, lastError.message);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }

    throw lastError || new Error('Operation failed after retries');
  }

  /**
   * Get configuration value with fallback
   */
  protected getConfig<T>(key: string, defaultValue?: T): T {
    const value = this.runtime.getSetting(key);
    if (value !== undefined && value !== null && value !== '') {
      return value as T;
    }

    if (defaultValue !== undefined) {
      return defaultValue;
    }

    throw new Error(`Missing required configuration: ${key}`);
  }

  /**
   * Clean up resources
   */
  async cleanup(): Promise<void> {
    elizaLogger.info(`Cleaning up ${this.constructor.name}`);
    await this.onCleanup();
  }

  /**
   * Service-specific cleanup logic
   */
  protected abstract onCleanup(): Promise<void>;
}
