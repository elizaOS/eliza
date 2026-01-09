/**
 * Expands a file path starting with `~` to the project directory.
 *
 * @param filepath - The path to expand.
 * @returns The expanded path.
 */
export declare function expandTildePath(filepath: string): string;
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
export declare function resolveEnvFile(startDir?: string): string;
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
export declare function resolvePgliteDir(
  dir?: string,
  fallbackDir?: string,
): string;
//# sourceMappingURL=utils.d.ts.map
