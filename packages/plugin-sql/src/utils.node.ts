import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Node-specific utils split out for server builds.
 */

/**
 * Checks if a database URL is for Neon serverless database.
 * When true, we use @neondatabase/serverless driver instead of pg.
 *
 * Neon URLs typically contain:
 * - neon.tech (Neon's main domain)
 * - neon.database (alternative domain)
 *
 * @example
 * isNeonDatabase('postgres://user:pass@ep-cool-name-123456.us-east-2.aws.neon.tech/dbname') // true
 * isNeonDatabase('postgres://user:pass@localhost:5432/dbname') // false
 */
export function isNeonDatabase(url: string): boolean {
  return url.includes('neon.tech') || url.includes('neon.database');
}

export function expandTildePath(filepath: string): string {
  if (filepath && filepath.startsWith('~')) {
    return path.join(process.cwd(), filepath.slice(1));
  }
  return filepath;
}

export function resolveEnvFile(startDir: string = process.cwd()): string {
  let currentDir = startDir;

  while (true) {
    const candidate = path.join(currentDir, '.env');
    if (existsSync(candidate)) {
      return candidate;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      break;
    }
    currentDir = parentDir;
  }

  return path.join(startDir, '.env');
}

export function resolvePgliteDir(dir?: string, fallbackDir?: string): string {
  const envPath = resolveEnvFile();
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }

  let monoPath;
  if (existsSync(path.join(process.cwd(), 'packages', 'core'))) {
    monoPath = process.cwd();
  } else {
    const twoUp = path.resolve(process.cwd(), '../..');
    if (existsSync(path.join(twoUp, 'packages', 'core'))) {
      monoPath = twoUp;
    }
  }

  const base =
    dir ??
    process.env.PGLITE_DATA_DIR ??
    fallbackDir ??
    (monoPath ? path.join(monoPath, '.eliza', '.elizadb') : undefined) ??
    path.join(process.cwd(), '.eliza', '.elizadb');

  const resolved = expandTildePath(base);
  const legacyPath = path.join(process.cwd(), '.elizadb');
  if (resolved === legacyPath) {
    const newPath = path.join(process.cwd(), '.eliza', '.elizadb');
    process.env.PGLITE_DATA_DIR = newPath;
    return newPath;
  }

  return resolved;
}
