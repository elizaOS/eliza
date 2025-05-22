import dotenv from 'dotenv';
import { existsSync } from 'node:fs';
import path from 'node:path';
// import { isMonorepoContext } from '@/src/utils'; // Replaced by UserEnvironment
import { UserEnvironment } from './user-environment';

/**
 * Expands a file path starting with `~` to the project directory.
 *
 * @param filepath - The path to expand.
 * @returns The expanded path.
 */
export function expandTildePath(
  filepath: string,
  projectRootForTilde: string = process.cwd()
): string {
  if (filepath && filepath.startsWith('~')) {
    // If ~ means project root, use projectRootForTilde. If it means OS home, os.homedir() would be used.
    // Assuming ~ means project root in this context based on previous behavior with cwd.
    return path.join(projectRootForTilde, filepath.slice(1));
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
 * Resolves the directory used for PGlite database storage.
 *
 * Resolution order:
 * 1. The `dir` argument if provided.
 * 2. The `PGLITE_DATA_DIR` environment variable.
 * 3. The `fallbackDir` argument if provided.
 * 4. `./.elizadb` relative to the current working directory.
 *
 * @param dir - Optional directory preference.
 * @param fallbackDir - Optional fallback directory when env var is not set.
 * @returns The resolved data directory with any tilde expanded.
 */
export async function resolvePgliteDir(dir?: string, fallbackDir?: string): Promise<string> {
  const userEnv = UserEnvironment.getInstance();
  const pathsInfo = await userEnv.getPathInfo();
  const projectRoot = pathsInfo.monorepoRoot || process.cwd(); // Base directory should be monorepo root or cwd

  // Use the envFilePath from UserEnvironment which is already correctly resolved
  if (pathsInfo.envFilePath && existsSync(pathsInfo.envFilePath)) {
    dotenv.config({ path: pathsInfo.envFilePath });
  }

  // The fallbackDir passed from getElizaDirectories will be monorepoRoot + '.elizadb' or similar.
  // If fallbackDir is not provided (e.g. direct call to resolvePgliteDir),
  // then we construct the default path using projectRoot.
  const defaultBaseDir = path.join(projectRoot, '.elizadb');

  const base = dir ?? process.env.PGLITE_DATA_DIR ?? fallbackDir ?? defaultBaseDir;

  // Pass projectRoot for tilde expansion, assuming ~ means project root.
  return expandTildePath(base, projectRoot);
}
