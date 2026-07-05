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
 *
 * Binding also stamps the task's memory world ({@link deriveProjectWorldId}):
 * this is the live implementation of #13776 design D3's per-project memory
 * partition — subagents on project B never see project A's injected context.
 * The derivation is deterministic in the project id, so it is the source of
 * truth even though the core `ProjectRecord.worldId` also persists it for CRUD.
 */

import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  getProjectById,
  logger,
  PROJECT_WORLD_ID_PREFIX,
  type ProjectRecord,
  readProjectRegistry,
  stringToUuid,
  upsertProject,
  type UUID,
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

/**
 * The memory world a project partitions into — `stringToUuid('project:' + id)`.
 * Deterministic so the agent runtime, desktop picker, and this bind seam all
 * derive the same world for a project id without coordinating through disk. This
 * is #13776 design D3's cheaper option: a dedicated free partition in the
 * existing memory schema, no column change.
 */
export function deriveProjectWorldId(projectId: string): UUID {
  return stringToUuid(`${PROJECT_WORLD_ID_PREFIX}${projectId}`);
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

/** The single source of truth for a spawn's workdir when a task may be bound.
 * Result of {@link resolveTaskSpawnWorkdir}. `lockWorkdir` is true only when a
 * project binding forced the directory — the caller must then SKIP route /
 * convention resolution so every session of a bound task targets the same repo
 * (#13776). */
export interface ResolvedTaskWorkdir {
  /** The winning workdir (project localPath, explicit param, or bound pin), or
   *  `undefined` when nothing is bound/explicit and the caller must fall back
   *  to route/convention/default resolution. */
  workdir: string | undefined;
  /** True when a registered project binding produced `workdir`; the caller must
   *  treat it as LOCKED (skip route/convention resolution). */
  lockWorkdir: boolean;
  /** How the workdir was chosen, for diagnostics. */
  source: "project" | "explicit" | "bound" | "unresolved";
}

/**
 * Resolve the workdir a task should spawn in, applying ONE precedence order at
 * BOTH the action entry point and the direct-service (`spawnAgentForTask`)
 * entry point so the same operator input can never diverge (#14108).
 *
 * Precedence (highest first):
 *   1. **project localPath** — a task bound to a registered Project always
 *      spawns in that project's `localPath`; this is a deliberate binding that
 *      outranks a per-call guess. Returned LOCKED (route/convention skipped).
 *   2. **explicit caller `workdir`** — an operator/caller-supplied directory
 *      beats the first-spawn pin. Not locked: it is still allow-list validated
 *      downstream, and unbound tasks fall through to route resolution.
 *   3. **`boundWorkdir`** — the directory pinned at the task's first spawn, so
 *      follow-up sessions can't silently migrate repos when routing env drifts
 *      between sessions (#13801 / #13776 item 3).
 *   4. otherwise **unresolved** — the caller resolves route/convention/default.
 *
 * When an explicit caller workdir LOSES to a project binding we do NOT silently
 * substitute: we log a loud warning so the divergence is visible instead of
 * mysterious (per the #14108 audit recommendation).
 */
export function resolveTaskSpawnWorkdir(
  input: {
    projectId?: string;
    boundWorkdir?: string;
    explicitWorkdir?: string;
  },
  env: NodeJS.ProcessEnv = process.env,
): ResolvedTaskWorkdir {
  const projectWorkdir = resolveBoundProjectWorkdir(input.projectId, env);
  const explicit = input.explicitWorkdir?.trim() || undefined;
  const bound = input.boundWorkdir?.trim() || undefined;

  // 1. Project binding wins — and is LOCKED.
  if (projectWorkdir) {
    if (explicit && canonical(explicit) !== canonical(projectWorkdir)) {
      // Loud, not silent: the explicit workdir is being overridden by the
      // project binding. Every entry point now behaves identically, so this
      // warning fires at both the action and the direct-service paths.
      logger.warn(
        `[workdir-precedence] explicit workdir ${explicit} overridden by ` +
          `project binding ${projectWorkdir} (projectId=${input.projectId}); ` +
          `a bound task always spawns in its project localPath (#14108).`,
      );
    }
    return { workdir: projectWorkdir, lockWorkdir: true, source: "project" };
  }

  // 2. Explicit caller workdir beats the first-spawn pin (not locked).
  if (explicit) {
    return { workdir: explicit, lockWorkdir: false, source: "explicit" };
  }

  // 3. The workdir pinned at the task's first spawn.
  if (bound) {
    return { workdir: bound, lockWorkdir: false, source: "bound" };
  }

  // 4. Nothing bound/explicit — caller resolves route/convention/default.
  return { workdir: undefined, lockWorkdir: false, source: "unresolved" };
}

/** The Cloud app id a bound task's Project already owns, or `null` when the task
 * is unbound, its project id is stale, or the project carries no Cloud app. Lets
 * a spawn tell the worker to update the existing app instead of duplicating it
 * (#14119). */
export function resolveBoundProjectCloudAppId(
  projectId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const id = projectId?.trim();
  if (!id) return null;
  return getProjectById(id, env)?.cloudAppId ?? null;
}

/**
 * Persist a Project↔Cloud-app binding: write `cloudAppId` onto the registered
 * project so the next task on it updates the existing app instead of creating a
 * duplicate (#14119). The registry is the single source of truth for this
 * relation — the broker calls this on an `apps.create` success for a
 * project-bound task. No-op returning `null` when the project id is unknown or
 * the app id is blank; when the project already carries a DIFFERENT cloudAppId
 * this overwrites it (the latest successful create wins). The underlying
 * `upsertProject` write is atomic (tmp-file + rename).
 */
export function bindProjectCloudApp(
  projectId: string | undefined,
  cloudAppId: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): ProjectRecord | null {
  const id = projectId?.trim();
  const appId = cloudAppId?.trim();
  if (!id || !appId) return null;
  const project = getProjectById(id, env);
  if (!project) return null;
  if (project.cloudAppId === appId) return project;
  return upsertProject({ ...project, cloudAppId: appId }, env);
}
