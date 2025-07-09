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
 * Resolves the path to the `.env` file, searching only within the start directory or
 * optionally up to a boundary directory (e.g., a monorepo root).
 *
 * @param startDir - Directory to begin the lookup (default: current working directory).
 * @param boundaryDir - Optional directory at which to stop searching upward.
 * @returns The path to the found `.env` file, or a path to `.env` in startDir if none found.
 */
export function resolveEnvFile(startDir: string = process.cwd(), boundaryDir?: string): string {
  const root = path.resolve(startDir);
  const stopAt = boundaryDir ? path.resolve(boundaryDir) : undefined;
  // If no boundary provided, only consider .env in the start directory
  if (!stopAt) {
    return path.join(root, '.env');
  }
  let current = root;
  while (true) {
    const candidate = path.join(current, '.env');
    if (existsSync(candidate)) {
      return candidate;
    }
    if (stopAt && current === stopAt) {
      break;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }
  return path.join(root, '.env');
}

/**
 * Resolves the directory used for PGlite database storage.
 *
 * Resolution order:
 * 1. The `dir` argument if provided.
 * 2. The `PGLITE_DATA_DIR` environment variable.
 * 3. The `fallbackDir` argument if provided.
 * 4. `./.eliza/.elizadb` relative to the current working directory.
 *
 * @param dir - Optional directory preference.
 * @param fallbackDir - Optional fallback directory when env var is not set.
 * @returns The resolved data directory with any tilde expanded.
 */
export async function resolvePgliteDir(
  dir?: string,
  fallbackDir?: string,
  targetProjectDir?: string
): Promise<string> {
  const userEnv = UserEnvironment.getInstance();
  const pathsInfo = await userEnv.getPathInfo();
  // When targetProjectDir is provided (e.g., during project creation), use it instead of monorepo root
  const projectRoot = targetProjectDir || pathsInfo.monorepoRoot || process.cwd();

  // When targetProjectDir is provided (during project creation), skip loading env vars
  // to prevent parent project's PGLITE_DATA_DIR from overriding the new project's database location
  if (!targetProjectDir && pathsInfo.envFilePath && existsSync(pathsInfo.envFilePath)) {
    dotenv.config({ path: pathsInfo.envFilePath });
  }

  // The fallbackDir passed from getElizaDirectories will be monorepoRoot + '.elizadb' or similar.
  // If fallbackDir is not provided (e.g. direct call to resolvePgliteDir),
  // then we construct the default path using projectRoot.
  const defaultBaseDir = path.join(projectRoot, '.eliza', '.elizadb');

  const base = dir ?? process.env.PGLITE_DATA_DIR ?? fallbackDir ?? defaultBaseDir;

  // Resolve and migrate legacy default (<projectRoot>/.elizadb) if detected
  const resolved = expandTildePath(base, projectRoot);
  const legacyPath = path.join(projectRoot, '.elizadb');
  if (resolved === legacyPath) {
    const newPath = path.join(projectRoot, '.eliza', '.elizadb');
    process.env.PGLITE_DATA_DIR = newPath;
    return newPath;
  }

  return resolved;
}
