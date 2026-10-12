/**
 * Self-edit gate and path denylist for the agent host.
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
 *     own safety rails and ship a build that self-edits in production. The
 *     suffix rails bind to the agent's own checkout ({@link resolveSelfEditRoot})
 *     while the flow is live; the identical relative shape in any other
 *     workspace stays editable, and `.git` metadata is refused everywhere.
 *
 * Callers may supply an environment snapshot; otherwise the gate reads the
 * host process environment.
 *
 * @module self-edit
 */
import { realpathSync } from "node:fs";
import * as path from "node:path";

import { isTruthyEnvValue } from "@elizaos/core/protocol";
/**
 * Env var the operator sets to opt in to self-edit. Defaults off.
 */
export const SELF_EDIT_ENABLE_ENV = "ELIZA_ENABLE_SELF_EDIT";
/**
 * Env var that, when truthy, marks the process as a developer-mode runtime
 * (in addition to / as an alternative to `NODE_ENV !== "production"`).
 */
export const DEV_MODE_ENV = "ELIZA_DEV_MODE";
/**
 * Predicate: is self-edit enabled for the current process?
 *
 * Returns `true` only when **all** of the following hold:
 *   1. `ELIZA_ENABLE_SELF_EDIT` is truthy (explicit operator opt-in).
 *   2. The process is not a production build, i.e. `NODE_ENV !== "production"`
 *      OR `ELIZA_DEV_MODE` is truthy. Either signal flips the gate on.
 *
 * The function is pure: pass an env snapshot for tests, default reads
 * `process.env`.
 */
export function isSelfEditEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
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
 * rails (the dev-mode gate, the restart action and its self-edit gate, the
 * host restart infrastructure, the process guards, the runner's exit-75 rate
 * limit, or this denylist itself).
 *
 * Maintenance constraint: every entry must name a file that exists in the
 * repository. An entry for a deleted file matches nothing, so it protects
 * no rail and hides a real gap from security review — when a protected
 * file moves, update its entry in the same change.
 *
 * Paths are normalized to forward-slash form for cross-platform comparison.
 */
const DENIED_RELATIVE_SUFFIXES: readonly string[] = [
  "packages/host/src/restart.ts",
  "packages/host/src/self-edit.ts",
  "packages/host/src/process-guards.ts",
  "packages/agent/src/actions/runtime.ts",
  "packages/app/scripts/run-node.ts",
  "packages/app/scripts/lib/restart-guard.ts",
];
/**
 * Env var the operator sets to bind the self-edit denylist to a specific
 * checkout root (absolute path). Unset, the root is derived from this
 * module's own location, which is the checkout the running host serves its
 * source from in both source mode (`packages/host/src/`) and compiled mode
 * (`packages/host/dist/`). Set it only when an unusual bundle layout makes
 * that derivation inert; a wrong or absent binding leaves the suffix rules
 * inert rather than over-broad.
 */
export const SELF_EDIT_ROOT_ENV = "ELIZA_SELF_EDIT_ROOT";
/**
 * Predicate: is `absolutePath` denied for self-edit modification?
 *
 * Refuses any path that:
 *   - contains a `.git` directory segment (any operation under any git
 *     metadata directory, in any workspace), or
 *   - ends with one of the {@link DENIED_RELATIVE_SUFFIXES} **while the
 *     self-edit flow is live** (`isSelfEditEnabled`) and the path sits inside
 *     the bound self-edit checkout ({@link resolveSelfEditRoot}). The same
 *     relative shape in any other workspace is an ordinary file the user may
 *     edit, so it is allowed.
 *
 * Returns `false` for empty / non-string input rather than throwing — callers
 * decide how to handle malformed input.
 */
export function isSelfEditPathDenied(
  absolutePath: string,
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  if (typeof absolutePath !== "string") return false;
  const trimmed = absolutePath.trim();
  if (!trimmed) return false;
  const normalized = normalizePathSeparators(trimmed);
  if (containsGitDirSegment(normalized)) return true;
  if (!isSelfEditEnabled(env)) return false;
  const root = resolveSelfEditRoot(env);
  if (!isWithinRoot(trimmed, root)) return false;
  for (const suffix of DENIED_RELATIVE_SUFFIXES) {
    if (pathEndsWithSegment(normalized, suffix)) return true;
  }
  return false;
}
/**
 * The checkout root the self-edit denylist binds to: the
 * `ELIZA_SELF_EDIT_ROOT` override when set to an absolute path, otherwise the
 * checkout containing this module's own source. The root is realpathed so
 * symlinked locations (macOS `/var` ↔ `/private/var`) match the
 * realpath-resolved paths the coding-tools sandbox hands its callers; a
 * missing root falls back to its lexical form so tests can bind pure paths.
 */
export function resolveSelfEditRoot(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): string {
  const override = env[SELF_EDIT_ROOT_ENV]?.trim();
  const candidate =
    override && path.isAbsolute(override)
      ? override
      : path.resolve(import.meta.dirname, "..", "..", "..");
  try {
    return realpathSync(candidate);
  } catch {
    // error-policy:J3 an unresolvable root keeps its lexical form instead of
    // silently binding to a directory that was never intended.
    return candidate;
  }
}
/**
 * The denied repo-relative suffixes, exposed for tests and tooling that
 * want to surface the denylist (e.g. UI banners, audit logs).
 */
export function getSelfEditDeniedSuffixes(): readonly string[] {
  return DENIED_RELATIVE_SUFFIXES;
}
function normalizePathSeparators(p: string): string {
  // Convert Windows-style separators to POSIX for uniform suffix matching.
  return p.replace(/\\/g, "/");
}
function isWithinRoot(p: string, root: string): boolean {
  // Both sides resolve to native form so forward- and back-slash inputs and
  // macOS/Linux symlinked roots compare equal; a different Windows drive
  // yields an absolute relative path and correctly reads as outside.
  const rel = path.relative(path.resolve(root), path.resolve(p));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
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
