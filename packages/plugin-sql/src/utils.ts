import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * Expands a file path starting with `~` to the project directory.
 *
 * @param filepath - The path to expand.
 * @returns The expanded path.
 */
export function expandTildePath(filepath: string): string {
  if (filepath && filepath.startsWith('~')) {
    return path.join(process.cwd(), filepath.slice(1));
  }
  return filepath;
}

/**
 * Resolves the path to the nearest `.env` file.
 *
 * If no `.env` file is found when traversing up from the starting directory,
 * a path to `.env` in the starting directory is returned.
 *
 * @param startDir - The directory to start searching from. Defaults to the
 *   current working directory.
 * @returns The resolved path to the `.env` file.
 */
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

/**
 * Resolves the directory used for SQLite database storage.
 *
 * Resolution order:
 * 1. The `dir` argument if provided.
 * 2. The `SQLITE_DATA_DIR` environment variable.
 * 3. The `fallbackDir` argument if provided.
 * 4. `./.elizadb` relative to the current working directory.
 *
 * @param dir - Optional directory preference.
 * @param fallbackDir - Optional fallback directory when env var is not set.
 * @returns The resolved data directory with any tilde expanded.
 */
export function resolveSqliteDir(dir?: string, fallbackDir?: string): string {
  const envPath = resolveEnvFile();
  if (existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }

  const base =
    dir ?? process.env.SQLITE_DATA_DIR ?? fallbackDir ?? path.join(process.cwd(), '.elizadb');
  return expandTildePath(base);
}

// Keep the old function name for backward compatibility during migration
export const resolvePgliteDir = resolveSqliteDir;
