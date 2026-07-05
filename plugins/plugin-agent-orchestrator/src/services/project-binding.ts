/**
 * Binds an orchestrator task to a registered Project from the core project
 * registry (`<stateDir>/projects.json`). A bound task's spawn workdir is
 * derived from the project's `localPath`, so every session of the task targets
 * the same repo — the fix for silent per-session repo drift (#13776).
 *
 * Resolution: an explicit projectId wins; otherwise a resolved spawn workdir is
 * realpath-matched against each registered project's localPath. No match =
 * unbound (undefined), preserving today's per-session workdir re-resolution.
 * Realpath is used on both sides so symlinked / non-canonical paths that point
 * at the same directory still match.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  getProjectById,
  type ProjectRecord,
  readProjectRegistry,
} from "@elizaos/core";

/** Canonicalize a path for identity comparison; falls back to a resolved
 * (non-realpath) absolute path when the target does not exist on disk. */
function canonical(p: string): string {
  const abs = resolve(p);
  try {
    return realpathSync(abs);
  } catch {
    // error-policy:J3 path may not exist yet (a project localPath can be
    // registered before its dir is cloned); compare the resolved absolute form.
    return abs;
  }
}

/** The registered project whose localPath is the same directory as `workdir`,
 * or `null` when none matches. */
export function findProjectByWorkdir(
  workdir: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ProjectRecord | null {
  const trimmed = workdir?.trim();
  if (!trimmed) return null;
  const registry = readProjectRegistry(env);
  if (!registry) return null;
  const target = canonical(trimmed);
  return (
    registry.projects.find((p) => canonical(p.localPath) === target) ?? null
  );
}

/**
 * Resolve the projectId a task should be bound to: an explicit id (validated
 * against the registry) beats a workdir realpath match; unknown/unmatched =
 * undefined (unbound).
 */
export function resolveTaskProjectId(
  input: { projectId?: string; workdir?: string },
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const explicit = input.projectId?.trim();
  if (explicit) {
    return getProjectById(explicit, env) ? explicit : undefined;
  }
  return findProjectByWorkdir(input.workdir, env)?.id;
}

/** The localPath of the registered project a bound task targets, or `null` when
 * the task is unbound or its project id is stale. Sessions of a bound task lock
 * to this directory so every spawn targets the same repo. */
export function resolveBoundProjectWorkdir(
  projectId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const id = projectId?.trim();
  if (!id) return null;
  return getProjectById(id, env)?.localPath ?? null;
}
