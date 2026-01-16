/**
 * elizaOS data directory paths configuration
 * This module provides a standard interface for accessing data directory paths
 * that can be customized via environment variables.
 */

/**
 * Join path segments, using native path.join in Node.js or simple string join in browser
 */
function pathJoin(...parts: string[]): string {
  if (typeof process !== "undefined" && process.platform) {
    const path = require("node:path");
    return path.join(...parts);
  }
  // Browser fallback: simple forward-slash join
  return parts.filter(Boolean).join("/").replace(/\/+/g, "/");
}

/**
 * Get the current working directory, with browser fallback
 */
function getCwd(): string {
  if (typeof process !== "undefined" && process.cwd) {
    return process.cwd();
  }
  return ".";
}

/**
 * Get an environment variable value
 */
function getEnvVar(key: string): string | undefined {
  if (typeof process !== "undefined" && process.env) {
    return process.env[key];
  }
  return undefined;
}

/**
 * Interface for elizaOS paths configuration
 */
export interface ElizaPathsConfig {
  dataDir: string;
  databaseDir: string;
  charactersDir: string;
  generatedDir: string;
  uploadsAgentsDir: string;
  uploadsChannelsDir: string;
}

/**
 * Path configuration with environment variable key and default subdirectory
 */
interface PathConfig {
  envKey: string;
  subPath: string[];
}

/**
 * Path configurations for all elizaOS directories
 */
const PATH_CONFIGS: Record<
  keyof Omit<ElizaPathsConfig, "dataDir">,
  PathConfig
> = {
  databaseDir: {
    envKey: "ELIZA_DATABASE_DIR",
    subPath: [".elizadb"],
  },
  charactersDir: {
    envKey: "ELIZA_DATA_DIR_CHARACTERS",
    subPath: ["data", "characters"],
  },
  generatedDir: {
    envKey: "ELIZA_DATA_DIR_GENERATED",
    subPath: ["data", "generated"],
  },
  uploadsAgentsDir: {
    envKey: "ELIZA_DATA_DIR_UPLOADS_AGENTS",
    subPath: ["data", "uploads", "agents"],
  },
  uploadsChannelsDir: {
    envKey: "ELIZA_DATA_DIR_UPLOADS_CHANNELS",
    subPath: ["data", "uploads", "channels"],
  },
};

/**
 * elizaOS paths management class
 * Provides centralized access to all elizaOS data directory paths
 */
class ElizaPaths {
  private cache = new Map<string, string>();

  /**
   * Get the base data directory
   */
  getDataDir(): string {
    const cached = this.cache.get("dataDir");
    if (cached) return cached;

    const dir = getEnvVar("ELIZA_DATA_DIR") || pathJoin(getCwd(), ".eliza");
    this.cache.set("dataDir", dir);
    return dir;
  }

  /**
   * Get the database directory (backward compatible with PGLITE_DATA_DIR)
   */
  getDatabaseDir(): string {
    return this.getPath("databaseDir", "PGLITE_DATA_DIR");
  }

  /**
   * Get the characters storage directory
   */
  getCharactersDir(): string {
    return this.getPath("charactersDir");
  }

  /**
   * Get the AI-generated content directory
   */
  getGeneratedDir(): string {
    return this.getPath("generatedDir");
  }

  /**
   * Get the agent uploads directory
   */
  getUploadsAgentsDir(): string {
    return this.getPath("uploadsAgentsDir");
  }

  /**
   * Get the channel uploads directory
   */
  getUploadsChannelsDir(): string {
    return this.getPath("uploadsChannelsDir");
  }

  /**
   * Get all paths as a configuration object
   */
  getAllPaths(): ElizaPathsConfig {
    return {
      dataDir: this.getDataDir(),
      databaseDir: this.getDatabaseDir(),
      charactersDir: this.getCharactersDir(),
      generatedDir: this.getGeneratedDir(),
      uploadsAgentsDir: this.getUploadsAgentsDir(),
      uploadsChannelsDir: this.getUploadsChannelsDir(),
    };
  }

  /**
   * Clear the cache (useful for testing)
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Get a path by config key, using cache
   */
  private getPath(
    key: keyof typeof PATH_CONFIGS,
    fallbackEnvKey?: string,
  ): string {
    const cached = this.cache.get(key);
    if (cached) return cached;

    const config = PATH_CONFIGS[key];
    const envValue =
      getEnvVar(config.envKey) ||
      (fallbackEnvKey ? getEnvVar(fallbackEnvKey) : undefined);
    const dir = envValue || pathJoin(this.getDataDir(), ...config.subPath);

    this.cache.set(key, dir);
    return dir;
  }
}

/**
 * Singleton instance of the ElizaPaths class
 */
let pathsInstance: ElizaPaths | null = null;

/**
 * Get the singleton ElizaPaths instance
 */
export function getElizaPaths(): ElizaPaths {
  if (!pathsInstance) {
    pathsInstance = new ElizaPaths();
  }
  return pathsInstance;
}

/**
 * Convenience function to get the data directory
 */
export function getDataDir(): string {
  return getElizaPaths().getDataDir();
}

/**
 * Convenience function to get the database directory
 */
export function getDatabaseDir(): string {
  return getElizaPaths().getDatabaseDir();
}

/**
 * Convenience function to get the characters directory
 */
export function getCharactersDir(): string {
  return getElizaPaths().getCharactersDir();
}

/**
 * Convenience function to get the generated content directory
 */
export function getGeneratedDir(): string {
  return getElizaPaths().getGeneratedDir();
}

/**
 * Convenience function to get the agent uploads directory
 */
export function getUploadsAgentsDir(): string {
  return getElizaPaths().getUploadsAgentsDir();
}

/**
 * Convenience function to get the channel uploads directory
 */
export function getUploadsChannelsDir(): string {
  return getElizaPaths().getUploadsChannelsDir();
}

/**
 * Convenience function to get all paths
 */
export function getAllElizaPaths(): ElizaPathsConfig {
  return getElizaPaths().getAllPaths();
}

/**
 * Reset the singleton instance (mainly for testing)
 */
export function resetPaths(): void {
  if (pathsInstance) {
    pathsInstance.clearCache();
  }
  pathsInstance = null;
}
