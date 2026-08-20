/**
 * Browser build of `./utils`: filesystem-backed path resolution has no
 * meaning in-browser, so these are fixed-value stubs. `sanitizeJsonObject`
 * is the shared implementation in `./sanitize-json.ts`.
 */
export function expandTildePath(filepath: string): string {
  return filepath;
}

export function resolveEnvFile(_startDir?: string): string {
  return ".env";
}

export function resolvePgliteDir(_dir?: string, _fallbackDir?: string): string {
  return "in-memory";
}

export {
  MAX_SQL_JSON_SANITIZE_DEPTH,
  SQL_JSON_SANITIZE_UNBOUNDED,
  sanitizeJsonObject,
} from "./sanitize-json.ts";
