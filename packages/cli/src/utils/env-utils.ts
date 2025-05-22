import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveEnvFile } from '@elizaos/core';

/**
 * Recursively search upward from the starting directory for the given file.
 *
 * @param filename Name of the file to find
 * @param startDir Directory to start searching from. Defaults to cwd.
 * @returns Absolute path to the file if found, otherwise null
 */
export function findNearestFile(filename: string, startDir: string = process.cwd()): string | null {
  let currentDir = startDir;

  while (true) {
    const candidate = path.join(currentDir, filename);
    if (existsSync(candidate)) return candidate;

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break; // reached filesystem root
    currentDir = parentDir;
  }

  return null;
}

/**
 * Find the nearest .env file starting from the given directory.
 *
 * @param startDir Directory to start searching from. Defaults to cwd.
 * @returns Path to the nearest .env file or null if none found
 */
export function findNearestEnvFile(startDir: string = process.cwd()): string | null {
  const envPath = resolveEnvFile(startDir);
  return existsSync(envPath) ? envPath : null;
}
