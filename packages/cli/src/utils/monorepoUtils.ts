import * as fs from 'fs';
import * as path from 'path';

/**
 * Finds the monorepo root by traversing upwards from a starting directory,
 * looking for a marker directory ('packages/core').
 *
 * @param startDir The directory to start searching from.
 * @returns The path to the monorepo root if found, otherwise null.
 */
function findMonorepoRoot(startDir: string): string | null {
  let currentDir = path.resolve(startDir);
  while (true) {
    const corePackagePath = path.join(currentDir, 'packages', 'core');
    if (fs.existsSync(corePackagePath)) {
      // Check if 'packages/core' itself exists and is a directory
      try {
        const stats = fs.statSync(corePackagePath);
        if (stats.isDirectory()) {
          return currentDir; // Found the root containing 'packages/core'
        }
      } catch (e) {
        // Ignore errors like permission denied, continue search
      }
    }

    // Optional: Check for other markers like .git if needed
    // const gitPath = path.join(currentDir, '.git');
    // if (fs.existsSync(gitPath)) { ... }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      // Reached the filesystem root
      return null;
    }
    currentDir = parentDir;
  }
}

/**
 * Checks if the current execution context is likely within the Eliza monorepo
 * by searching upwards for the 'packages/core' directory.
 * It starts searching from the current working directory.
 *
 * @returns {boolean} True if the 'packages/core' directory is found in an ancestor directory, false otherwise.
 */
export function isElizaMonorepoContext(): boolean {
  const root = findMonorepoRoot(process.cwd());
  return root !== null;
}

/**
 * Gets the detected monorepo root path.
 * Searches upwards from the current working directory.
 *
 * @returns {string | null} The absolute path to the monorepo root, or null if not found.
 */
export function getMonorepoRoot(): string | null {
  return findMonorepoRoot(process.cwd());
}
