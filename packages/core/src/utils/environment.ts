/**
 * Browser and Node.js compatible environment variable abstraction
 * This module provides a unified interface for accessing environment variables
 * that works in both browser and Node.js environments.
 */

/**
 * Type representing the runtime environment
 */
export type RuntimeEnvironment = 'node' | 'browser' | 'unknown';

/**
 * Interface for environment configuration
 */
export interface EnvironmentConfig {
  [key: string]: string | boolean | number | undefined;
}

/**
 * Detect the current runtime environment
 */
export function detectEnvironment(): RuntimeEnvironment {
  // Check for Node.js
  if (typeof process !== 'undefined' && process.versions && process.versions.node) {
    return 'node';
  }

  // Check for browser
  if (
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as any).window !== 'undefined' &&
    typeof (globalThis as any).window.document !== 'undefined'
  ) {
    return 'browser';
  }

  return 'unknown';
}

/**
 * Environment variable storage for browser environments
 */
class BrowserEnvironmentStore {
  private store: EnvironmentConfig = {};

  constructor() {
    // Load from window.ENV if available (common pattern for browser apps)
    if (
      typeof globalThis !== 'undefined' &&
      (globalThis as any).window &&
      (globalThis as any).window.ENV
    ) {
      this.store = { ...(globalThis as any).window.ENV };
    }

    // Also check for __ENV__ (another common pattern)
    if (typeof globalThis !== 'undefined' && (globalThis as any).__ENV__) {
      this.store = { ...this.store, ...(globalThis as any).__ENV__ };
    }
  }

  get(key: string): string | undefined {
    const value = this.store[key];
    return value !== undefined ? String(value) : undefined;
  }

  set(key: string, value: string | boolean | number): void {
    this.store[key] = value;
  }

  has(key: string): boolean {
    return key in this.store;
  }

  getAll(): EnvironmentConfig {
    return { ...this.store };
  }
}

/**
 * Environment abstraction class
 */
class Environment {
  private runtime: RuntimeEnvironment;
  private browserStore?: BrowserEnvironmentStore;
  private cache: Map<string, string | undefined> = new Map();

  constructor() {
    this.runtime = detectEnvironment();

    if (this.runtime === 'browser') {
      this.browserStore = new BrowserEnvironmentStore();
    }
  }

  /**
   * Get the current runtime environment
   */
  getRuntime(): RuntimeEnvironment {
    return this.runtime;
  }

  /**
   * Check if running in Node.js
   */
  isNode(): boolean {
    return this.runtime === 'node';
  }

  /**
   * Check if running in browser
   */
  isBrowser(): boolean {
    return this.runtime === 'browser';
  }

  /**
   * Get an environment variable
   */
  get(key: string, defaultValue?: string): string | undefined {
    // Check cache first
    if (this.cache.has(key)) {
      const cached = this.cache.get(key);
      return cached === undefined && defaultValue !== undefined ? defaultValue : cached;
    }

    let value: string | undefined;

    switch (this.runtime) {
      case 'node':
        // In Node.js, use process.env
        if (typeof process !== 'undefined' && process.env) {
          value = process.env[key];
        }
        break;

      case 'browser':
        // In browser, use our store
        if (this.browserStore) {
          value = this.browserStore.get(key);
        }
        break;

      default:
        value = undefined;
    }

    // Cache the result
    this.cache.set(key, value);

    return value === undefined && defaultValue !== undefined ? defaultValue : value;
  }

  /**
   * Set an environment variable (mainly for browser/testing)
   */
  set(key: string, value: string | boolean | number): void {
    const stringValue = String(value);

    // Clear cache
    this.cache.delete(key);

    switch (this.runtime) {
      case 'node':
        if (typeof process !== 'undefined' && process.env) {
          process.env[key] = stringValue;
        }
        break;

      case 'browser':
        if (this.browserStore) {
          this.browserStore.set(key, value);
        }
        break;
    }
  }

  /**
   * Check if an environment variable exists
   */
  has(key: string): boolean {
    const value = this.get(key);
    return value !== undefined;
  }

  /**
   * Get all environment variables (filtered for safety)
   */
  getAll(): EnvironmentConfig {
    switch (this.runtime) {
      case 'node':
        if (typeof process !== 'undefined' && process.env) {
          return { ...process.env };
        }
        break;

      case 'browser':
        if (this.browserStore) {
          return this.browserStore.getAll();
        }
        break;
    }

    return {};
  }

  /**
   * Get a boolean environment variable
   */
  getBoolean(key: string, defaultValue = false): boolean {
    const value = this.get(key);

    if (value === undefined) {
      return defaultValue;
    }

    // Common truthy values
    return ['true', '1', 'yes', 'on'].includes(value.toLowerCase());
  }

  /**
   * Get a number environment variable
   */
  getNumber(key: string, defaultValue?: number): number | undefined {
    const value = this.get(key);

    if (value === undefined) {
      return defaultValue;
    }

    const parsed = Number(value);
    return isNaN(parsed) ? defaultValue : parsed;
  }

  /**
   * Clear the cache (useful for testing)
   */
  clearCache(): void {
    this.cache.clear();
  }
}

/**
 * Singleton instance of the Environment class
 */
let environmentInstance: Environment | null = null;

/**
 * Get the singleton Environment instance
 */
export function getEnvironment(): Environment {
  if (!environmentInstance) {
    environmentInstance = new Environment();
  }
  return environmentInstance;
}

/**
 * Convenience function to get an environment variable
 */
export function getEnv(key: string, defaultValue?: string): string | undefined {
  return getEnvironment().get(key, defaultValue);
}

/**
 * Convenience function to set an environment variable
 */
export function setEnv(key: string, value: string | boolean | number): void {
  getEnvironment().set(key, value);
}

/**
 * Convenience function to check if an environment variable exists
 */
export function hasEnv(key: string): boolean {
  return getEnvironment().has(key);
}

/**
 * Convenience function to get a boolean environment variable
 */
export function getBooleanEnv(key: string, defaultValue = false): boolean {
  return getEnvironment().getBoolean(key, defaultValue);
}

/**
 * Convenience function to get a number environment variable
 */
export function getNumberEnv(key: string, defaultValue?: number): number | undefined {
  return getEnvironment().getNumber(key, defaultValue);
}

/**
 * Initialize browser environment with config
 * This should be called early in browser apps to set up environment
 */
export function initBrowserEnvironment(config: EnvironmentConfig): void {
  const env = getEnvironment();
  if (env.isBrowser()) {
    Object.entries(config).forEach(([key, value]) => {
      if (value !== undefined) {
        env.set(key, value);
      }
    });
  }
}

/**
 * Export the current runtime for convenience
 */
export const currentRuntime = detectEnvironment();

/**
 * Re-export the Environment class for advanced usage
 */
export { Environment };
