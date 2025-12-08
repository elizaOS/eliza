/**
 * Server configuration utilities
 */

import path from 'node:path';
import { existsSync } from 'node:fs';
import dotenv from 'dotenv';
import { type UUID, parseBooleanFromText, getDatabaseDir } from '@elizaos/core';
import { resolveEnvFile } from '../api/system/environment.js';

// Re-export types from types/server.ts for convenience
export type { ServerMiddleware, ServerConfig } from '../types/server.js';

/**
 * Default server ID for single-server deployments
 */
export const DEFAULT_SERVER_ID = '00000000-0000-0000-0000-000000000000' as UUID;

/**
 * Expands a file path starting with `~` to the project directory.
 */
export function expandTildePath(filepath: string): string {
  if (!filepath) {
    return filepath;
  }

  if (filepath.startsWith('~')) {
    if (filepath === '~') {
      return process.cwd();
    } else if (filepath.startsWith('~/')) {
      return path.join(process.cwd(), filepath.slice(2));
    } else if (filepath.startsWith('~~')) {
      return filepath;
    } else {
      return path.join(process.cwd(), filepath.slice(1));
    }
  }

  return filepath;
}

/**
 * Resolves the PGLite data directory path.
 */
export function resolvePgliteDir(dir?: string, fallbackDir?: string): string {
  const envPath = resolveEnvFile();
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }

  if (dir) {
    const resolved = expandTildePath(dir);
    process.env.PGLITE_DATA_DIR = resolved;
    return resolved;
  }

  if (fallbackDir && !process.env.PGLITE_DATA_DIR && !process.env.ELIZA_DATABASE_DIR) {
    const resolved = expandTildePath(fallbackDir);
    process.env.PGLITE_DATA_DIR = resolved;
    return resolved;
  }

  const resolved = getDatabaseDir();
  process.env.PGLITE_DATA_DIR = resolved;
  return resolved;
}

/**
 * Determines if the web UI should be enabled based on environment variables.
 */
export function isWebUIEnabled(): boolean {
  const isProduction = process.env.NODE_ENV === 'production';
  const uiEnabledEnv = process.env.ELIZA_UI_ENABLE;

  if (uiEnabledEnv !== undefined && uiEnabledEnv.trim() !== '') {
    return parseBooleanFromText(uiEnabledEnv);
  }

  return !isProduction;
}
