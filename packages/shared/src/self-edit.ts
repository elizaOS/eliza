/**
 * Self-edit gate + path denylist — browser-safe.
 *
 * "Self-edit" is the dev-mode capability whereby the running agent edits its
 * own source (UI, agent code, plugins, even `node_modules` and the `eliza/`
 * submodule) and then triggers a restart so the new code is picked up on the
 * next boot. It is strictly a developer affordance — never enabled in a
 * packaged production build.
 *
 * This module exposes two pure helpers:
 *   - {@link isSelfEditEnabled} — env-gate that consumers call before running
 *     any self-edit code path. Returns `true` only when the operator has
 *     opted in *and* the process is not a production build.
 *   - {@link isSelfEditPathDenied} — refuses to let the self-edit flow modify
 *     the gate itself, the restart machinery, or anything inside `.git/`.
 *     Defense in depth so a buggy or adversarial sub-agent cannot remove its
 *     own safety rails and ship a build that self-edits in production.
 *
 * Both functions are pure (env / string in → boolean out) and use no
 * node-only APIs, so this module can be imported anywhere `@elizaos/shared`
 * is consumed (browser, agent runtime, CLI).
 *
 * @module self-edit
 */

import { isTruthyEnvValue } from "./env-utils.js";

/**
 * Env var the operator sets to opt in to self-edit. Defaults off.
 */
export const SELF_EDIT_ENABLE_ENV = "MILADY_ENABLE_SELF_EDIT";

/**
 * Env var that, when truthy, marks the process as a developer-mode runtime
 * (in addition to / as an alternative to `NODE_ENV !== "production"`).
 */
export const DEV_MODE_ENV = "MILADY_DEV_MODE";

/**
 * Predicate: is self-edit enabled for the current process?
 *
 * Returns `true` only when **all** of the following hold:
 *   1. `MILADY_ENABLE_SELF_EDIT` is truthy (explicit operator opt-in).
 *   2. The process is not a production build, i.e. `NODE_ENV !== "production"`
 *      OR `MILADY_DEV_MODE` is truthy. Either signal flips the gate on.
 *
 * The function is pure: pass an env snapshot for tests, default reads
 * `process.env`.
 */
export function isSelfEditEnabled(
  env:
    | NodeJS.ProcessEnv
    | Record<string, string | undefined> = readProcessEnv(),
): boolean {
  if (!isTruthyEnvValue(env[SELF_EDIT_ENABLE_ENV])) return false;

  const nodeEnv = env.NODE_ENV;
  const devModeFlag = isTruthyEnvValue(env[DEV_MODE_ENV]);
  const isProduction = nodeEnv === "production";

  // In production builds, the dev-mode flag must be explicitly set to override.
  // Non-production runtimes pass through.
  if (isProduction && !devModeFlag) return false;

  return true;
}

/**
 * Repo-relative paths that the self-edit flow must NEVER modify. Removing or
 * weakening any of these would allow the agent to disable its own safety
 * rails (the dev-mode gate, the restart action's keyword/owner check, the
 * runner's exit-75 rate limit, or this denylist itself).
 *
 * Paths are normalized to forward-slash form for cross-platform comparison.
 */
const DENIED_RELATIVE_SUFFIXES: readonly string[] = [
  "packages/agent/src/actions/restart.ts",
  "packages/shared/src/restart.ts",
  "packages/shared/src/self-edit.ts",
  "scripts/run-node.mjs",
  "packages/app-core/scripts/run-node.mjs",
];

/**
 * Predicate: is `absolutePath` denied for self-edit modification?
 *
 * Refuses any path that:
 *   - contains a `.git` directory segment (any operation under any git
 *     metadata directory), or
 *   - ends with one of the {@link DENIED_RELATIVE_SUFFIXES} (the self-edit
 *     gate, restart machinery, or runner script).
 *
 * Returns `false` for empty / non-string input rather than throwing — callers
 * decide how to handle malformed input.
 */
export function isSelfEditPathDenied(absolutePath: string): boolean {
  if (typeof absolutePath !== "string") return false;
  const trimmed = absolutePath.trim();
  if (!trimmed) return false;

  const normalized = normalizePathSeparators(trimmed);

  if (containsGitDirSegment(normalized)) return true;

  for (const suffix of DENIED_RELATIVE_SUFFIXES) {
    if (pathEndsWithSegment(normalized, suffix)) return true;
  }
  return false;
}

/**
 * The denied repo-relative suffixes, exposed for tests and tooling that
 * want to surface the denylist (e.g. UI banners, audit logs).
 */
export function getSelfEditDeniedSuffixes(): readonly string[] {
  return DENIED_RELATIVE_SUFFIXES;
}

function readProcessEnv():
  | NodeJS.ProcessEnv
  | Record<string, string | undefined> {
  // `process` may not exist in browser builds; fall back to an empty record.
  if (typeof process === "undefined" || !process || !process.env) {
    return {};
  }
  return process.env;
}

function normalizePathSeparators(p: string): string {
  // Convert Windows-style separators to POSIX for uniform suffix matching.
  return p.replace(/\\/g, "/");
}

function containsGitDirSegment(normalized: string): boolean {
  // Match `.git` as a path segment: leading/trailing slash, or end-of-string.
  // Handles `/.git/`, `/.git` (trailing), and `.git/` at the start of a relative path.
  if (normalized === ".git" || normalized.startsWith(".git/")) return true;
  if (normalized.endsWith("/.git")) return true;
  return normalized.includes("/.git/");
}

function pathEndsWithSegment(normalized: string, suffix: string): boolean {
  const normalizedSuffix = normalizePathSeparators(suffix);
  if (normalized === normalizedSuffix) return true;
  return normalized.endsWith(`/${normalizedSuffix}`);
}
