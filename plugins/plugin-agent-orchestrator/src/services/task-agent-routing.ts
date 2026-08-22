/**
 * Resolves how a spawn is routed: normalizes a caller's backend/adapter name to
 * a known adapter type and picks the working directory for a new coding session
 * from the configured workspace-root env keys and per-label routing rules.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { resolveAppDeployConfig } from "./app-deploy-guidance.js";
import { readConfigEnvKey } from "./config-env.js";

export const KNOWN_ADAPTER_TYPES = new Set([
  "elizaos",
  "pi-agent",
  "claude",
  "codex",
]);

export function normalizeTaskAgentAdapter(
  value: string | undefined,
): string | undefined {
  const normalized = value?.trim().toLowerCase().replace(/_/g, "-");
  if (!normalized) return undefined;
  switch (normalized) {
    case "elizaos":
    case "eliza-os":
    case "eliza":
    case "eliza-code":
    case "eliza code":
    // "opencode" is a retired backend name; requests naming it route to the
    // eliza-code (elizaos) adapter.
    case "opencode":
    case "open-code":
    case "open code":
      return "elizaos";
    case "pi-agent":
    case "pi agent":
    case "pi":
      return "pi-agent";
    case "claude":
    case "claude-code":
    case "claude code":
      return "claude";
    case "codex":
    case "openai":
    case "openai-codex":
    case "openai codex":
      return "codex";
    default:
      return normalized;
  }
}

export interface WorkdirRoute {
  id: string;
  workdir: string;
  matchAll?: string[];
  matchAny?: string[];
  excludeAny?: string[];
  instructions?: string;
  urlMappings?: WorkdirRouteUrlMapping[];
}

export interface WorkdirRouteUrlMapping {
  urlPrefix: string;
  localPath: string;
  requireFresh?: boolean;
}

export interface ResolvedWorkdirRoute {
  id: string;
  workdir: string;
  instructions?: string;
  urlMappings?: WorkdirRouteUrlMapping[];
}

export function resolvePinnedAdapter(
  runtime: IAgentRuntime | undefined,
): string | undefined {
  const getSetting = (key: string): string | undefined => {
    const fromRuntime =
      typeof runtime?.getSetting === "function"
        ? (runtime.getSetting(key) as string | undefined)
        : undefined;
    return (
      fromRuntime ?? readConfigEnvKey(key) ?? process.env[key] ?? undefined
    );
  };
  const strategy = (getSetting("ELIZA_AGENT_SELECTION_STRATEGY") ?? "fixed")
    .toLowerCase()
    .trim();
  if (strategy !== "fixed") return undefined;
  const raw = normalizeTaskAgentAdapter(
    getSetting("BENCHMARK_TASK_AGENT") ??
      getSetting("ELIZA_ACP_DEFAULT_AGENT") ??
      getSetting("ELIZA_DEFAULT_AGENT_TYPE"),
  );
  if (!raw) return undefined;
  return KNOWN_ADAPTER_TYPES.has(raw) ? raw : undefined;
}

/** Directories a build must never land in by planner invention: the home
 *  directory itself, any ancestor of a configured route's workdir (the
 *  projects folder that holds real repos), and the runtime's own checkout. */
function isProtectedLocation(
  runtime: IAgentRuntime | undefined,
  workdir: string,
): boolean {
  const resolved = path.resolve(workdir);
  const home = path.resolve(os.homedir());
  if (resolved === home) return true;
  const cwdRoot = path.resolve(process.cwd());
  if (resolved === cwdRoot || cwdRoot.startsWith(`${resolved}${path.sep}`)) {
    return true;
  }
  for (const route of configuredWorkdirRoutes(runtime)) {
    const routeDir = path.resolve(expandHomePath(route.workdir));
    if (
      routeDir !== resolved &&
      routeDir.startsWith(`${resolved}${path.sep}`)
    ) {
      return true;
    }
  }
  return false;
}

/** Whether an explicit existing workdir has a reason to be honored: it sits
 *  inside a configured route tree or the published-apps dir, the user named
 *  it (path or last segment) in the request or task text, or it is the
 *  workdir of a session the orchestrator knows (a finished lane being
 *  continued). Anything else is a planner-invented path. */
function explicitWorkdirIsGrounded(
  runtime: IAgentRuntime | undefined,
  workdir: string,
  userRequest: string,
  task: string,
): boolean {
  const resolved = path.resolve(workdir);
  if (resolveRouteForWorkdir(runtime, resolved)) return true;
  const deploy = resolveAppDeployConfig();
  if (
    deploy.target === "custom" &&
    deploy.customAppsDir &&
    resolved.startsWith(`${path.resolve(deploy.customAppsDir)}${path.sep}`)
  ) {
    return true;
  }
  const mentioned = `${userRequest}\n${task}`;
  const base = path.basename(resolved);
  if (
    mentioned.toLowerCase().includes(resolved.toLowerCase()) ||
    mentioned.toLowerCase().includes(workdir.toLowerCase()) ||
    (base.length >= 3 && containsPhrase(mentioned, base))
  ) {
    return true;
  }
  const acp = runtime?.getService?.("ACP_SERVICE") as
    | { listSessions?: () => unknown }
    | null
    | undefined;
  const sessions = acp?.listSessions?.();
  if (Array.isArray(sessions)) {
    return sessions.some(
      (session) =>
        typeof (session as { workdir?: unknown }).workdir === "string" &&
        path.resolve(String((session as { workdir: string }).workdir)) ===
          resolved,
    );
  }
  return false;
}

export function resolveSpawnWorkdir(
  runtime: IAgentRuntime | undefined,
  task: string,
  userRequest: string,
  explicitWorkdir: string | undefined,
  opts: { lockWorkdir?: boolean } = {},
): { workdir: string; route?: ResolvedWorkdirRoute; isolate?: boolean } {
  const expandedExplicit = explicitWorkdir
    ? expandHomePath(explicitWorkdir)
    : undefined;
  // Route identity follows the DIRECTORY on every route-less resolution
  // below: a chosen workdir inside a configured route's tree carries that
  // route's id/instructions even when the request text matched nothing
  // (#20794 — the residuals shared_route_workdir exemption reads the stamp).
  const withContainedRoute = (result: {
    workdir: string;
    isolate?: boolean;
  }): { workdir: string; route?: ResolvedWorkdirRoute; isolate?: boolean } => {
    const contained = resolveRouteForWorkdir(runtime, result.workdir);
    return contained ? { ...result, route: contained } : result;
  };
  if (opts.lockWorkdir && expandedExplicit && fs.existsSync(expandedExplicit)) {
    return withContainedRoute({ workdir: expandedExplicit });
  }
  const route = resolveWorkdirRoute(runtime, task, userRequest);
  if (route) return { workdir: route.workdir, route };
  // Auto-detect: when `TASK_AGENT_WORKDIR_ROOTS` is set (one or more
  // colon-separated base dirs, default `~/Projects`), look for an
  // immediate subdir whose name appears in the user request / task. This
  // is convention-over-configuration — no per-project route entry needed
  // as long as the project directory is named like the user refers to it.
  const detected = resolveWorkdirByConvention(runtime, task, userRequest);
  if (detected) return withContainedRoute({ workdir: detected });
  const fallback = resolveDefaultSpawnWorkdir(runtime);
  if (
    expandedExplicit &&
    fs.existsSync(expandedExplicit) &&
    isProtectedLocation(runtime, expandedExplicit) &&
    !explicitWorkdirIsGrounded(runtime, expandedExplicit, userRequest, task)
  ) {
    // The planner fills `workdir` on every create ("/home/milady/<label>",
    // live 2026-08-22 on every build). An existing scratch dir stays trusted
    // (the established contract), but a PROTECTED location — the home dir,
    // the parent of a configured route, the agent's own checkout — that
    // nothing grounds (not a route tree, not named by the user, not a known
    // lane's dir) would land a fresh build in an unrelated real directory.
    logger.warn(
      `[workdir-routes] Planner workdir is a protected location nothing grounds; ignoring it: ${expandedExplicit} — falling back to ${fallback.workdir}`,
    );
    return fallback.isolate
      ? { workdir: fallback.workdir, isolate: true }
      : { workdir: fallback.workdir };
  }
  if (expandedExplicit && fs.existsSync(expandedExplicit)) {
    if (
      fallback.isolate &&
      path.resolve(expandedExplicit) === path.resolve(process.cwd())
    ) {
      logger.warn(
        `[workdir-routes] Planner explicit workdir equals runtime cwd (${expandedExplicit}), ignoring it and using configured workspace ${fallback.workdir}`,
      );
      return { workdir: fallback.workdir, isolate: true };
    }
    return withContainedRoute({ workdir: expandedExplicit });
  }
  if (expandedExplicit) {
    // A nonexistent explicit workdir directly under the configured published-
    // apps dir is the PLANNER DOING THE RIGHT THING — naming the fresh slug
    // dir for a new app. Rejecting it dropped the build into a scratch
    // workspace with no served URL and verification parked a working page
    // (live 2026-08-19: …/data/apps/moon-phase-page). Create and use it.
    const deploy = resolveAppDeployConfig();
    if (
      deploy.target === "custom" &&
      deploy.customAppsDir &&
      path.dirname(path.resolve(expandedExplicit)) ===
        path.resolve(deploy.customAppsDir)
    ) {
      try {
        fs.mkdirSync(expandedExplicit, { recursive: true });
        return withContainedRoute({ workdir: expandedExplicit });
      } catch {
        // error-policy:J4 mkdir failure falls through to the scratch fallback.
      }
    }
    logger.warn(
      `[workdir-routes] Planner workdir does not exist, ignoring it: ${expandedExplicit} — falling back to ${fallback.workdir}`,
    );
  }
  // `isolate` is only set when the fallback landed on a SHARED scratch root
  // (a configured ELIZA_ACP_WORKSPACE_ROOT / ACPX_DEFAULT_CWD) — spawnSession
  // then gives each concurrent session its own subdir so simultaneous projects
  // can't collide. cwd (self-checkout) and route/convention/explicit matches
  // resolve to a specific directory and are never auto-isolated.
  return fallback.isolate
    ? { workdir: fallback.workdir, isolate: true }
    : { workdir: fallback.workdir };
}

/**
 * Last-resort spawn cwd when a task matched no route/convention/explicit
 * workdir. Honors the documented default workspace settings so simple, non-repo
 * tasks land in a dedicated scratch dir instead of writing into the runtime's
 * own source checkout.
 *
 * Precedence (first configured value wins; each key is read first from the
 * runtime setting, then — at lower priority — from the config file's env
 * section / process env via `readConfigEnvKey`):
 *
 *   1. `ELIZA_ACP_WORKSPACE_ROOT`  — ACP-specific scratch root
 *                                     (the one `AcpService.spawnSession` consults)
 *   2. `ACPX_DEFAULT_CWD`          — ACP default cwd
 *   3. `ELIZA_WORKSPACE_DIR`       — general workspace dir (set by store builds)
 *   4. `ELIZA_CODING_WORKSPACE`    — coding-workspace dir
 *   5. `ELIZA_CODING_DIRECTORY`    — user coding directory (the same key
 *                                     `WorkspaceService` honors for scratch dirs)
 *   …falling back to `process.cwd()` only when none is configured, preserving
 *   the run-in-place default for self-checkout workflows.
 *
 * A configured value is treated as a SHARED scratch root → `isolate=true` so
 * each concurrent spawned session gets its own subdir; the `process.cwd()`
 * fallback is never isolated.
 */
function resolveDefaultSpawnWorkdir(runtime: IAgentRuntime | undefined): {
  workdir: string;
  isolate: boolean;
} {
  const getSetting = (key: string): string | undefined =>
    typeof runtime?.getSetting === "function"
      ? (runtime.getSetting(key) as string | undefined)
      : undefined;
  // Prefer the ACP-specific scratch root, then the general coding-workspace dirs.
  // Falling through to ELIZA_WORKSPACE_DIR / ELIZA_CODING_WORKSPACE /
  // ELIZA_CODING_DIRECTORY means an operator who points the runtime at a coding
  // workspace (the common case) gets spawns landing THERE instead of in the eliza
  // runtime root (process.cwd(), e.g. /app) — which otherwise causes "build me X"
  // tasks to grep the eliza repo in place instead of scaffolding fresh.
  // ELIZA_CODING_DIRECTORY is included for parity with WorkspaceService, which
  // honors it for scratch-dir placement (workspace-service.ts).
  const configured =
    getSetting("ELIZA_ACP_WORKSPACE_ROOT") ??
    getSetting("ACPX_DEFAULT_CWD") ??
    getSetting("ELIZA_WORKSPACE_DIR") ??
    getSetting("ELIZA_CODING_WORKSPACE") ??
    getSetting("ELIZA_CODING_DIRECTORY") ??
    readConfigEnvKey("ELIZA_ACP_WORKSPACE_ROOT") ??
    readConfigEnvKey("ACPX_DEFAULT_CWD") ??
    readConfigEnvKey("ELIZA_WORKSPACE_DIR") ??
    readConfigEnvKey("ELIZA_CODING_WORKSPACE") ??
    readConfigEnvKey("ELIZA_CODING_DIRECTORY");
  const trimmed = configured?.trim();
  // A configured workspace ROOT is a shared scratch area for ad-hoc spawned
  // tasks → isolate=true so each concurrent session gets its own subdir.
  // With nothing configured we keep process.cwd() WITHOUT isolation, preserving
  // the run-in-place self-checkout workflow (the agent edits the repo in place).
  return trimmed
    ? { workdir: expandHomePath(trimmed), isolate: true }
    : { workdir: process.cwd(), isolate: false };
}

export function resolveWorkdirByConvention(
  runtime: IAgentRuntime | undefined,
  task: string,
  userRequest: string,
): string | undefined {
  const rootsRaw =
    (typeof runtime?.getSetting === "function"
      ? (runtime.getSetting("TASK_AGENT_WORKDIR_ROOTS") as string | undefined)
      : undefined) ??
    readConfigEnvKey("TASK_AGENT_WORKDIR_ROOTS") ??
    process.env.TASK_AGENT_WORKDIR_ROOTS ??
    "~/Projects";
  // Use the OS path delimiter so Windows drives (`C:\projects;D:\work`) parse
  // correctly. `:` would otherwise split a Windows drive letter mid-path.
  const roots = rootsRaw
    .split(path.delimiter)
    .map((r) => r.trim())
    .filter(Boolean)
    .map(expandHomePath);
  const haystack = `${userRequest}\n${task}`.toLowerCase();
  const matches: string[] = [];
  for (const root of roots) {
    let entries: string[];
    try {
      entries = fs
        .readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith("."))
        .map((e) => e.name);
    } catch {
      // error-policy:J4 configured workspace root may not exist; unreadable root → skip, degrade to default workdir
      continue;
    }
    for (const name of entries) {
      // Match the directory name as a contiguous phrase. Hyphens and
      // spaces are interchangeable so `camping-car-europe` matches
      // "camping car europe" and vice versa.
      const variants = new Set([
        name.toLowerCase(),
        name.toLowerCase().replace(/-/g, " "),
        name.toLowerCase().replace(/\s+/g, "-"),
      ]);
      for (const variant of variants) {
        if (variant.length < 4) continue; // skip generic tokens like "app"
        if (haystack.includes(variant)) {
          matches.push(path.join(root, name));
          break;
        }
      }
    }
  }
  if (matches.length === 1) {
    logger.info(
      `[workdir-routes] Auto-detected workdir by convention: ${matches[0]}`,
    );
    return matches[0];
  }
  if (matches.length > 1) {
    logger.warn(
      `[workdir-routes] Auto-detect ambiguous (${matches.length} matches): ${matches.join(", ")} — falling back`,
    );
  }
  return undefined;
}

function configuredWorkdirRoutes(
  runtime: IAgentRuntime | undefined,
): WorkdirRoute[] {
  const runtimeSetting =
    typeof runtime?.getSetting === "function"
      ? (runtime.getSetting("TASK_AGENT_WORKDIR_ROUTES") as string | undefined)
      : undefined;
  const raw =
    runtimeSetting ??
    readConfigEnvKey("TASK_AGENT_WORKDIR_ROUTES") ??
    process.env.TASK_AGENT_WORKDIR_ROUTES;
  return parseWorkdirRoutes(raw);
}

/**
 * Reverse route lookup by directory containment: the route whose workdir tree
 * contains (or equals) `workdir`. Text matching identifies a route from what
 * the user SAID; this identifies it from where the session actually LANDS —
 * a planner-passed explicit workdir inside a shared route checkout is the
 * same shared checkout whether or not the request phrasing matched, and the
 * route identity (residuals exemption, route instructions) must follow the
 * directory, not the phrasing (#20794 stamp gap).
 */
export function resolveRouteForWorkdir(
  runtime: IAgentRuntime | undefined,
  workdir: string,
): ResolvedWorkdirRoute | undefined {
  let target: string;
  try {
    target = fs.realpathSync(expandHomePath(workdir));
  } catch {
    // error-policy:J3 Reverse lookup only applies to an existing, resolvable
    // directory. Callers will retain their normal route-less fallback.
    return undefined;
  }
  const candidates: Array<{
    route: WorkdirRoute;
    canonicalRouteRoot: string;
  }> = [];
  for (const route of configuredWorkdirRoutes(runtime)) {
    const expanded = expandHomePath(route.workdir);
    let canonicalRouteRoot: string;
    try {
      canonicalRouteRoot = fs.realpathSync(expanded);
    } catch {
      // error-policy:J4 A missing or unreadable configured route is skipped so
      // another valid route can still own the resolved workdir.
      continue;
    }
    const relative = path.relative(canonicalRouteRoot, target);
    const contained =
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative));
    if (contained) candidates.push({ route, canonicalRouteRoot });
  }
  // A route table may intentionally contain a broad checkout plus narrower
  // project routes. Directory ownership belongs to the closest configured
  // ancestor, independent of JSON ordering.
  candidates.sort(
    (left, right) =>
      right.canonicalRouteRoot.length - left.canonicalRouteRoot.length,
  );
  for (const { route, canonicalRouteRoot } of candidates) {
    // Do not let a broad shared-checkout route cross into a nested repository
    // or worktree. Its residuals exemption would otherwise suppress the nested
    // repository's own uncommitted/unpushed work. A route configured at the
    // nested repository root remains eligible because its own .git marker is
    // the boundary, not something crossed beneath it.
    let cursor = target;
    let crossesNestedRepository = false;
    while (cursor !== canonicalRouteRoot) {
      if (fs.existsSync(path.join(cursor, ".git"))) {
        crossesNestedRepository = true;
        break;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    if (crossesNestedRepository) continue;
    return {
      id: route.id,
      // ResolvedWorkdirRoute is persisted and inherited by later sub-agent
      // turns, so it must carry the session's actual directory rather than the
      // configured ancestor. Otherwise TASKS:spawn_agent relocates the session
      // through `effectiveRoute.workdir` after resolution.
      workdir: target,
      instructions: route.instructions,
      urlMappings: route.urlMappings,
    };
  }
  return undefined;
}

export function resolveWorkdirRoute(
  runtime: IAgentRuntime | undefined,
  task: string,
  userRequest: string,
): ResolvedWorkdirRoute | undefined {
  const routes = configuredWorkdirRoutes(runtime);
  if (routes.length === 0) return undefined;
  const haystack = `${userRequest}\n${task}`.toLowerCase();
  for (const route of routes) {
    if (!routeMatches(route, haystack)) continue;
    const expanded = expandHomePath(route.workdir);
    let canonicalWorkdir: string;
    try {
      canonicalWorkdir = fs.realpathSync(expanded);
    } catch {
      logger.warn(
        `[workdir-routes] Route "${route.id}" matched but workdir does not exist: ${expanded}`,
      );
      continue;
    }
    logger.info(
      `[workdir-routes] Matched route "${route.id}" → workdir=${expanded}`,
    );
    return {
      id: route.id,
      workdir: canonicalWorkdir,
      instructions: route.instructions,
      urlMappings: route.urlMappings,
    };
  }
  return undefined;
}

function parseWorkdirRoutes(raw: string | undefined): WorkdirRoute[] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is WorkdirRoute =>
        entry &&
        typeof entry === "object" &&
        typeof entry.id === "string" &&
        typeof entry.workdir === "string" &&
        // The guard claims WorkdirRoute, so it must actually validate the
        // array-typed fields routeMatches() iterates with .some() — otherwise a
        // misconfigured `"matchAll": "foo"` reaches routeMatches and throws.
        (entry.matchAll === undefined || Array.isArray(entry.matchAll)) &&
        (entry.matchAny === undefined || Array.isArray(entry.matchAny)) &&
        (entry.excludeAny === undefined || Array.isArray(entry.excludeAny)) &&
        (entry.urlMappings === undefined || Array.isArray(entry.urlMappings)),
    );
  } catch (err) {
    // error-policy:J3 untrusted config; TASK_AGENT_WORKDIR_ROUTES parse failure → warn + no routes
    logger.warn(
      `[workdir-routes] Failed to parse TASK_AGENT_WORKDIR_ROUTES: ${(err as Error).message}`,
    );
    return [];
  }
}

function routeMatches(route: WorkdirRoute, haystack: string): boolean {
  if (route.matchAll?.some((term) => !containsPhrase(haystack, term))) {
    return false;
  }
  if (
    route.matchAny?.length &&
    !route.matchAny.some((term) => containsPhrase(haystack, term))
  ) {
    return false;
  }
  return !route.excludeAny?.some((term) => containsPhrase(haystack, term));
}

function containsPhrase(haystack: string, phrase: string): boolean {
  const normalized = phrase.toLowerCase().trim();
  if (!normalized) return false;
  const startBoundary = /^[a-z0-9]/.test(normalized) ? "\\b" : "";
  const endBoundary = /[a-z0-9]$/.test(normalized) ? "\\b" : "";
  const pattern = new RegExp(
    `${startBoundary}${escapeForRegex(normalized)}${endBoundary}`,
    "i",
  );
  return pattern.test(haystack);
}

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function expandHomePath(value: string): string {
  return value.startsWith("~")
    ? path.join(os.homedir(), value.slice(1))
    : value;
}
