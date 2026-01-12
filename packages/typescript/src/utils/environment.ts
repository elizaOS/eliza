/**
 * Browser and Node.js compatible environment variable abstraction
 * This module provides a cross-platform interface for accessing environment variables
 * that works in both browser and Node.js environments.
 */

/**
 * Type representing the runtime environment
 */
export type RuntimeEnvironment = "node" | "browser" | "unknown";

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
  if (
    typeof process !== "undefined" &&
    process.versions &&
    process.versions.node
  ) {
    return "node";
  }

  // Check for browser
  if (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as { window?: Window }).window !== "undefined" &&
    typeof (globalThis as { document?: Document }).document !== "undefined"
  ) {
    return "browser";
  }

  return "unknown";
}

/**
 * Environment variable storage for browser environments
 */
class BrowserEnvironmentStore {
  private store: EnvironmentConfig = {};

  constructor() {
    // Load from window.ENV if available (common pattern for browser apps)
    const globalWindow = (
      globalThis as { window?: { ENV?: EnvironmentConfig } }
    ).window;
    if (globalWindow?.ENV) {
      this.store = { ...globalWindow.ENV };
    }

    // Also check for __ENV__ (another common pattern)
    const globalEnv = (globalThis as { __ENV__?: EnvironmentConfig }).__ENV__;
    if (globalEnv) {
      this.store = { ...this.store, ...globalEnv };
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
  private readonly runtime: RuntimeEnvironment;
  private browserStore: BrowserEnvironmentStore | null = null;
  private cache: Map<string, string | undefined> = new Map();

  constructor() {
    this.runtime = detectEnvironment();
    if (this.runtime === "browser") {
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
    return this.runtime === "node";
  }

  /**
   * Check if running in browser
   */
  isBrowser(): boolean {
    return this.runtime === "browser";
  }

  /**
   * Get an environment variable
   */
  get(key: string, defaultValue?: string): string | undefined {
    // Check cache first
    if (this.cache.has(key)) {
      const cached = this.cache.get(key);
      return cached ?? defaultValue;
    }

    let value: string | undefined;

    if (this.runtime === "node") {
      value = process.env[key];
    } else if (this.browserStore) {
      value = this.browserStore.get(key);
    }

    // Cache the result
    this.cache.set(key, value);

    return value ?? defaultValue;
  }

  /**
   * Set an environment variable (mainly for browser/testing)
   */
  set(key: string, value: string | boolean | number): void {
    const stringValue = String(value);

    // Clear cache
    this.cache.delete(key);

    if (this.runtime === "node") {
      process.env[key] = stringValue;
    } else if (this.browserStore) {
      this.browserStore.set(key, value);
    }
  }

  /**
   * Check if an environment variable exists
   */
  has(key: string): boolean {
    return this.get(key) !== undefined;
  }

  /**
   * Get all environment variables
   */
  getAll(): EnvironmentConfig {
    if (this.runtime === "node") {
      return { ...process.env };
    }

    if (this.browserStore) {
      return this.browserStore.getAll();
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
    return ["true", "1", "yes", "on"].includes(value.toLowerCase());
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
    return Number.isNaN(parsed) ? defaultValue : parsed;
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
export function getNumberEnv(
  key: string,
  defaultValue?: number,
): number | undefined {
  return getEnvironment().getNumber(key, defaultValue);
}

/**
 * Initialize browser environment with config
 * This should be called early in browser apps to set up environment
 */
export function initBrowserEnvironment(config: EnvironmentConfig): void {
  const env = getEnvironment();
  if (env.isBrowser()) {
    for (const [key, value] of Object.entries(config)) {
      if (value !== undefined) {
        env.set(key, value);
      }
    }
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
  filenames: string[] = [".env", ".env.local"],
): string | null {
  if (typeof process === "undefined" || !process.cwd) {
    return null;
  }

  const fs = require("node:fs");
  const path = require("node:path");

  let currentDir = startDir || process.cwd();

  while (true) {
    for (const filename of filenames) {
      const candidate = path.join(currentDir, filename);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return null;
}

/**
 * Load environment variables from .env file into process.env
 *
 * Node.js only - does nothing in browser environments
 *
 * @param envPath - Optional explicit path to .env file. If not provided, will search upwards from cwd
 * @returns true if .env was found and loaded successfully
 * @throws Error if the .env file exists but cannot be parsed
 */
export function loadEnvFile(envPath?: string): boolean {
  if (typeof process === "undefined" || !process.cwd) {
    return false;
  }

  const dotenv = require("dotenv");

  const resolvedPath = envPath || findEnvFile();
  if (!resolvedPath) {
    return false;
  }

  const result = dotenv.config({ path: resolvedPath });

  if (result.error) {
    throw new Error(
      `Failed to parse .env file at ${resolvedPath}: ${result.error.message}`,
    );
  }

  return true;
}
