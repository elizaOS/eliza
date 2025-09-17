/**
 * ElizaOS data directory paths configuration
 * This module provides a unified interface for accessing data directory paths
 * that can be customized via environment variables.
 */

import path from 'node:path';

/**
 * Interface for ElizaOS paths configuration
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
 * ElizaOS paths management class
 * Provides centralized access to all ElizaOS data directory paths
 */
class ElizaPaths {
  private cache: Map<string, string> = new Map();

  /**
   * Get the base data directory
   */
  getDataDir(): string {
    const cached = this.cache.get('dataDir');
    if (cached) return cached;

    const dir = process.env.ELIZA_DATA_DIR || path.join(process.cwd(), '.eliza');
    this.cache.set('dataDir', dir);
    return dir;
  }

  /**
   * Get the database directory (backward compatible with PGLITE_DATA_DIR)
   */
  getDatabaseDir(): string {
    const cached = this.cache.get('databaseDir');
    if (cached) return cached;

    const dir =
      process.env.ELIZA_DATABASE_DIR ||
      process.env.PGLITE_DATA_DIR ||
      path.join(this.getDataDir(), '.elizadb');
    this.cache.set('databaseDir', dir);
    return dir;
  }

  /**
   * Get the characters storage directory
   */
  getCharactersDir(): string {
    const cached = this.cache.get('charactersDir');
    if (cached) return cached;

    const dir =
      process.env.ELIZA_DATA_DIR_CHARACTERS || path.join(this.getDataDir(), 'data', 'characters');
    this.cache.set('charactersDir', dir);
    return dir;
  }

  /**
   * Get the AI-generated content directory
   */
  getGeneratedDir(): string {
    const cached = this.cache.get('generatedDir');
    if (cached) return cached;

    const dir =
      process.env.ELIZA_DATA_DIR_GENERATED || path.join(this.getDataDir(), 'data', 'generated');
    this.cache.set('generatedDir', dir);
    return dir;
  }

  /**
   * Get the agent uploads directory
   */
  getUploadsAgentsDir(): string {
    const cached = this.cache.get('uploadsAgentsDir');
    if (cached) return cached;

    const dir =
      process.env.ELIZA_DATA_DIR_UPLOADS_AGENTS ||
      path.join(this.getDataDir(), 'data', 'uploads', 'agents');
    this.cache.set('uploadsAgentsDir', dir);
    return dir;
  }

  /**
   * Get the channel uploads directory
   */
  getUploadsChannelsDir(): string {
    const cached = this.cache.get('uploadsChannelsDir');
    if (cached) return cached;

    const dir =
      process.env.ELIZA_DATA_DIR_UPLOADS_CHANNELS ||
      path.join(this.getDataDir(), 'data', 'uploads', 'channels');
    this.cache.set('uploadsChannelsDir', dir);
    return dir;
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
