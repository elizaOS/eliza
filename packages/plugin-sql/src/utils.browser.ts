/**
 * Browser-safe utils for plugin-sql
 *
 * These versions avoid Node-specific modules (fs/path/dotenv) and simply
 * provide minimal fallbacks appropriate for browser builds.
 */

/**
 * Expand a tilde-prefixed path.
 * In the browser, paths are not used for storage; just return input.
 */
export function expandTildePath(filepath: string): string {
  return filepath;
}

/**
 * Resolve an env file path.
 * No-op in browser; returns a placeholder string.
 */
export function resolveEnvFile(_startDir?: string): string {
  return '.env';
}

/**
 * Resolve PGlite data directory.
 * In browser builds we default to in-memory PGlite; return a stable placeholder.
 */
export function resolvePgliteDir(_dir?: string, _fallbackDir?: string): string {
  return 'in-memory';
}
