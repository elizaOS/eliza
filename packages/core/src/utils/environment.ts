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
  interface GlobalWithWindow {
    window?: Window & {
      document?: Document;
    };
  }

  if (
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as GlobalWithWindow).window !== 'undefined' &&
    typeof (globalThis as GlobalWithWindow).window?.document !== 'undefined'
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
    interface GlobalWithWindowEnv {
      window?: {
        ENV?: EnvironmentConfig;
      };
    }

    interface GlobalWithEnv {
      __ENV__?: EnvironmentConfig;
    }

    // Load from window.ENV if available (common pattern for browser apps)
    const windowWithEnv = globalThis as GlobalWithWindowEnv;
    if (typeof globalThis !== 'undefined' && windowWithEnv.window && windowWithEnv.window.ENV) {
      this.store = { ...windowWithEnv.window.ENV };
    }

    // Also check for __ENV__ (another common pattern)
    const globalWithEnv = globalThis as GlobalWithEnv;
    if (typeof globalThis !== 'undefined' && globalWithEnv.__ENV__) {
      this.store = { ...this.store, ...globalWithEnv.__ENV__ };
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

// ============================================================================
// .env File Loading (Node.js only)
// ============================================================================

/**
 * Find the .env file by traversing up the directory tree
 * Searches from startDir upwards until it finds a .env file or reaches the root
 *
 * @param startDir - Directory to start searching from (defaults to process.cwd())
 * @param filenames - Array of filenames to search for (defaults to ['.env', '.env.local'])
 * @returns Path to the .env file if found, null otherwise
 */
export function findEnvFile(
  startDir?: string,
  filenames: string[] = ['.env', '.env.local']
): string | null {
  if (typeof process === 'undefined' || !process.cwd) {
    return null;
  }

  // Dynamic import to avoid bundling issues in browser
  const fs = require('node:fs');
  const path = require('node:path');

  let currentDir = startDir || process.cwd();

  // Traverse up the directory tree
  while (true) {
    // Check each possible filename in the current directory
    for (const filename of filenames) {
      const candidate = path.join(currentDir, filename);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    // Move to parent directory
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      // Reached root, stop searching
      break;
    }
    currentDir = parentDir;
  }

  return null;
}

/**
 * Load environment variables from .env file into process.env
 * This function is idempotent - safe to call multiple times
 *
 * Node.js only - does nothing in browser environments
 *
 * @param envPath - Optional explicit path to .env file. If not provided, will search upwards from cwd
 * @returns true if .env was found and loaded, false otherwise
 *
 * @example
 * ```typescript
 * // Load from auto-discovered .env file
 * loadEnvFile();
 *
 * // Load from specific path
 * loadEnvFile('/path/to/.env');
 * ```
 */
export function loadEnvFile(envPath?: string): boolean {
  if (typeof process === 'undefined' || !process.cwd) {
    return false;
  }

  // Dynamic import to avoid bundling dotenv in browser
  const dotenv = require('dotenv');

  // Find .env file if path not explicitly provided
  const resolvedPath = envPath || findEnvFile();
  if (!resolvedPath) {
    return false;
  }

  // Load .env into process.env
  // Note: dotenv won't override existing process.env vars, but calling loadEnvFile()
  // multiple times with different paths will merge variables from multiple files
  const result = dotenv.config({ path: resolvedPath });

  if (result.error) {
    // File exists but couldn't be parsed
    if (typeof console !== 'undefined' && console.warn) {
      console.warn(`Failed to parse .env file at ${resolvedPath}:`, result.error);
    }
    return false;
  }

  return true;
}
