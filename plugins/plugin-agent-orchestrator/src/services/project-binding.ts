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

/**
 * Raised when a caller passes an explicit spawn workdir that conflicts with the
 * task's project binding. A project-bound task always spawns in its project's
 * localPath; rather than silently substituting the project path for the
 * operator's explicit request (which produced divergent, unobservable behavior
 * at the action vs service entry points — #14108), the conflict is surfaced so
 * the caller can retract the workdir or rebind the task.
 */
export class WorkdirBindingConflictError extends Error {
  constructor(
    readonly explicitWorkdir: string,
    readonly projectWorkdir: string,
  ) {
    super(
      `explicit workdir "${explicitWorkdir}" conflicts with the task's project binding "${projectWorkdir}"; ` +
        "a project-bound task always spawns in its project's localPath — omit the explicit workdir, or rebind the task's project",
    );
    this.name = "WorkdirBindingConflictError";
  }
}

/**
 * The single source of truth for spawn-workdir precedence, shared by the action
 * layer (`SPAWN_AGENT`) and the service layer (`spawnAgentForTask`) so the same
 * operator input resolves identically regardless of entry point (#14108).
 *
 * Precedence: **project localPath > explicit caller workdir > boundWorkdir**.
 * A project binding is authoritative — every session of a project-bound task
 * targets the same repo (#13776). But rather than *silently* discarding an
 * explicit caller workdir, a project-bound task rejects a conflicting explicit
 * workdir loudly (`WorkdirBindingConflictError`); an explicit workdir equal to
 * the project path, or absent, is accepted. Unbound tasks fall through to the
 * explicit workdir, then the older per-first-spawn `boundWorkdir` pin.
 *
 * Paths are compared by realpath so symlinked / non-canonical forms of the same
 * directory do not read as a conflict.
 */
export function resolveSpawnWorkdirPrecedence(input: {
  projectWorkdir: string | null | undefined;
  explicitWorkdir: string | null | undefined;
  boundWorkdir: string | null | undefined;
}): string | undefined {
  const project = input.projectWorkdir?.trim() || undefined;
  const explicit = input.explicitWorkdir?.trim() || undefined;
  const bound = input.boundWorkdir?.trim() || undefined;
  if (project) {
    if (explicit && canonical(explicit) !== canonical(project)) {
      throw new WorkdirBindingConflictError(explicit, project);
    }
    return project;
  }
  return explicit ?? bound;
}
