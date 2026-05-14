/**
 * Helper functions for the START_CODING_TASK action.
 *
 * - createScratchDir()      -- Creates a scratch sandbox directory for non-repo tasks
 * - generateLabel()         -- Generate a short semantic label from repo URL and/or task description
 * - registerSessionEvents() -- Register lifecycle event handlers for a spawned session
 *
 * @module actions/coding-task-helpers
 */

import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { type HandlerCallback, logger } from "@elizaos/core";
import { readConfigEnvKey } from "../services/config-env.js";
import type { PTYService } from "../services/pty-service.js";
import type { SkillSessionAllowList } from "../services/skill-callback-bridge.js";
import { getCodingWorkspaceService } from "../services/workspace-service.js";

/**
 * Sanitize a label into a safe directory name.
 * Strips non-alphanumeric chars (keeps hyphens), lowercases, truncates to 60 chars.
 */
function sanitizeDirName(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || "scratch"
  );
}

/**
 * Find a non-colliding directory path by appending -2, -3, etc. if needed.
 */
function resolveNonColliding(baseDir: string, name: string): string {
  let candidate = path.join(baseDir, name);
  if (!fs.existsSync(candidate)) return candidate;
  for (let i = 2; i < 100; i++) {
    candidate = path.join(baseDir, `${name}-${i}`);
    if (!fs.existsSync(candidate)) return candidate;
  }
  // Fallback to uuid to guarantee uniqueness
  return path.join(baseDir, `${name}-${randomUUID().slice(0, 8)}`);
}

/**
 * Create a scratch sandbox directory for non-repo tasks.
 *
 * When `PARALLAX_CODING_DIRECTORY` is set (e.g. `~/Projects`), creates a
 * named subdir like `~/Projects/todo-app/` derived from the task label.
 * Otherwise falls back to `~/.eliza/workspaces/{uuid}`.
 */
export function createScratchDir(
  runtime?: IAgentRuntime,
  label?: string,
): string {
  // Check for user-configured coding directory.
  // Try runtime settings → config file env → process.env (in priority order).
  // Config file is checked directly because runtime.getSetting() doesn't read
  // the config env section, and process.env is only set at boot time.
  const codingDir =
    (runtime?.getSetting("PARALLAX_CODING_DIRECTORY") as string) ??
    readConfigEnvKey("PARALLAX_CODING_DIRECTORY") ??
    process.env.PARALLAX_CODING_DIRECTORY;

  if (codingDir?.trim()) {
    const resolved = codingDir.startsWith("~")
      ? path.join(os.homedir(), codingDir.slice(1))
      : path.resolve(codingDir);
    const dirName = label
      ? sanitizeDirName(label)
      : `scratch-${randomUUID().slice(0, 8)}`;
    const scratchDir = resolveNonColliding(resolved, dirName);
    fs.mkdirSync(scratchDir, { recursive: true });
    return scratchDir;
  }

  // Default: ephemeral UUID-based dir
  const baseDir = path.join(os.homedir(), ".eliza", "workspaces");
  const scratchId = randomUUID();
  const scratchDir = path.join(baseDir, scratchId);
  fs.mkdirSync(scratchDir, { recursive: true });
  return scratchDir;
}

/**
 * Adapter names recognised by the canonical `coding-agent-adapters` package.
 * Operators that pin one of these via `PARALLAX_DEFAULT_AGENT_TYPE` express a
 * deployment-level policy: "use this adapter for sub-agent spawns regardless
 * of what the planner LLM decided." When the strategy is `fixed` (the
 * default) the pin overrides planner-supplied `agentType`.
 */
const KNOWN_ADAPTER_TYPES = new Set([
  "claude",
  "codex",
  "opencode",
  "gemini",
  "aider",
  "hermes",
]);

/**
 * Resolve the operator-pinned coding adapter from configuration. Returns the
 * pinned adapter name when both `PARALLAX_DEFAULT_AGENT_TYPE` is set to a
 * recognised value AND `PARALLAX_AGENT_SELECTION_STRATEGY` is `fixed` (or
 * unset, which defaults to `fixed`). Otherwise returns `undefined` and the
 * caller falls back to the planner's choice or dynamic resolution.
 */
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
  const strategy = (getSetting("PARALLAX_AGENT_SELECTION_STRATEGY") ?? "fixed")
    .toLowerCase()
    .trim();
  if (strategy !== "fixed") return undefined;
  const raw = getSetting("PARALLAX_DEFAULT_AGENT_TYPE")?.trim().toLowerCase();
  if (!raw) return undefined;
  return KNOWN_ADAPTER_TYPES.has(raw) ? raw : undefined;
}

/**
 * A single entry in `TASK_AGENT_WORKDIR_ROUTES`. The config value is a JSON
 * array of these. Each route declares a target workdir for sub-agent spawns
 * whose task text matches the gate (matchAll AND matchAny AND NOT excludeAny).
 */
export interface WorkdirRoute {
  id: string;
  workdir: string;
  matchAll?: string[];
  matchAny?: string[];
  excludeAny?: string[];
  instructions?: string;
}

export interface ResolvedWorkdirRoute {
  id: string;
  workdir: string;
  instructions?: string;
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
        typeof entry.workdir === "string",
    );
  } catch (err) {
    logger.warn(
      `[workdir-routes] Failed to parse TASK_AGENT_WORKDIR_ROUTES: ${(err as Error).message}`,
    );
    return [];
  }
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Match against word boundaries, not raw substrings: otherwise short tokens
 * cause false positives ("pr" matches inside "preview", "ai" inside "plain",
 * "site" inside "website" if site was in excludeAny). The phrase can be
 * multi-word; boundaries are checked only against the first/last token edges.
 */
function containsPhrase(haystack: string, phrase: string): boolean {
  if (!phrase) return false;
  const trimmed = phrase.toLowerCase().trim();
  if (!trimmed) return false;
  // Punctuation-only or hyphenated tokens skip word-boundary anchors when
  // they would never match (e.g. \b doesn't anchor between two hyphens).
  const startBoundary = /^[a-z0-9]/.test(trimmed) ? "\\b" : "";
  const endBoundary = /[a-z0-9]$/.test(trimmed) ? "\\b" : "";
  const pattern = new RegExp(
    `${startBoundary}${escapeForRegex(trimmed)}${endBoundary}`,
    "i",
  );
  return pattern.test(haystack);
}

function routeMatches(route: WorkdirRoute, haystack: string): boolean {
  if (route.matchAll?.length) {
    for (const term of route.matchAll) {
      if (!containsPhrase(haystack, term.toLowerCase())) return false;
    }
  }
  if (route.matchAny?.length) {
    const any = route.matchAny.some((term) =>
      containsPhrase(haystack, term.toLowerCase()),
    );
    if (!any) return false;
  }
  if (route.excludeAny?.length) {
    for (const term of route.excludeAny) {
      if (containsPhrase(haystack, term.toLowerCase())) return false;
    }
  }
  return true;
}

function expandHomePath(p: string): string {
  return p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
}

/**
 * Resolve the workdir for a sub-agent spawn, given whatever workdir the
 * caller passed (`explicitWorkdir`) and the task text.
 *
 * Precedence:
 *  1. `lockWorkdir` + an explicit workdir → that workdir wins, no route
 *     resolution. This is the opt-out for scaffold-aware callers (e.g.
 *     APP_CREATE dispatching into a freshly-scaffolded `eliza/apps/<name>`):
 *     they KNOW the workdir is correct and pass `lockWorkdir: true`.
 *  2. A matching `TASK_AGENT_WORKDIR_ROUTES` route wins over an unlocked
 *     explicit workdir. The explicit workdir on a bare planner spawn is
 *     just whatever path-shaped string the planner LLM guessed from context
 *     — it is NOT trustworthy even when it happens to exist on disk (the
 *     planner will cheerfully pick `/home/milady` or the repo root).
 *     Operator-declared routes are deliberate policy and outrank the guess.
 *  3. No route → the explicit workdir as-is (caller creates it if missing).
 *  4. Nothing supplied → `process.cwd()`.
 *
 * Returns the resolved workdir plus the matched route (if any) so callers can
 * surface the route's `instructions` to the sub-agent.
 */
export function resolveSpawnWorkdir(
  runtime: IAgentRuntime | undefined,
  task: string,
  userRequest: string,
  explicitWorkdir: string | undefined,
  opts: { lockWorkdir?: boolean } = {},
): { workdir: string; route?: ResolvedWorkdirRoute } {
  const expandedExplicit = explicitWorkdir
    ? expandHomePath(explicitWorkdir)
    : undefined;
  if (opts.lockWorkdir && expandedExplicit) {
    return { workdir: expandedExplicit };
  }
  const route = resolveWorkdirRoute(runtime, task, userRequest);
  if (route) return { workdir: route.workdir, route };
  if (expandedExplicit) return { workdir: expandedExplicit };
  return { workdir: process.cwd() };
}

/**
 * Resolve a workdir route for a sub-agent spawn from the
 * `TASK_AGENT_WORKDIR_ROUTES` config-env entry. Returns the first matching
 * route or `undefined` if none match (or the config is empty/malformed).
 *
 * Prefer `resolveSpawnWorkdir` from call sites — it layers the
 * explicit-workdir precedence on top. This is exported separately for
 * targeted tests and callers that only need the route match.
 *
 * The match phrase searches both the user's original request and the specific
 * sub-task text — sub-task splits often drop context words the matcher needs.
 * The target workdir must already exist on disk; routes pointing at missing
 * directories are skipped with a warning so callers fall back to scratch.
 */
export function resolveWorkdirRoute(
  runtime: IAgentRuntime | undefined,
  task: string,
  userRequest: string,
): ResolvedWorkdirRoute | undefined {
  const runtimeSetting =
    typeof runtime?.getSetting === "function"
      ? (runtime.getSetting("TASK_AGENT_WORKDIR_ROUTES") as string | undefined)
      : undefined;
  const raw =
    runtimeSetting ??
    readConfigEnvKey("TASK_AGENT_WORKDIR_ROUTES") ??
    process.env.TASK_AGENT_WORKDIR_ROUTES;
  const routes = parseWorkdirRoutes(raw);
  if (routes.length === 0) return undefined;
  const haystack = `${userRequest}\n${task}`.toLowerCase();
  for (const route of routes) {
    if (!routeMatches(route, haystack)) continue;
    const expanded = route.workdir.startsWith("~")
      ? path.join(os.homedir(), route.workdir.slice(1))
      : route.workdir;
    if (!fs.existsSync(expanded)) {
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
      workdir: expanded,
      instructions: route.instructions,
    };
  }
  return undefined;
}

/**
 * Generate a short semantic label from repo URL and/or task description.
 * e.g. "git-workspace-service-testbed/hello-mima" or "scratch/react-research"
 */
export function generateLabel(
  repo: string | undefined,
  task: string | undefined,
): string {
  const parts: string[] = [];

  if (repo) {
    // Extract repo name from URL: "https://github.com/owner/my-repo.git" -> "my-repo"
    const match = repo.match(/\/([^/]+?)(?:\.git)?$/);
    parts.push(match ? match[1] : "repo");
  } else {
    parts.push("scratch");
  }

  if (task) {
    // Extract a slug from the first few meaningful words of the task
    const slug = task
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .split(/\s+/)
      .filter(
        (w) =>
          w.length > 2 &&
          !["the", "and", "for", "with", "that", "this", "from"].includes(w),
      )
      .slice(0, 3)
      .join("-");
    if (slug) parts.push(slug);
  }

  return parts.join("/");
}

/**
 * Register lifecycle event handlers for a spawned session.
 *
 * When `coordinatorActive` is true the SwarmCoordinator owns chat messaging
 * and session lifecycle for blocked / task_complete / error events.
 * This listener still handles scratch-dir cleanup regardless.
 */
export function registerSessionEvents(
  ptyService: PTYService,
  runtime: IAgentRuntime,
  sessionId: string,
  label: string,
  scratchDir: string | null,
  callback?: HandlerCallback,
  coordinatorActive = false,
  skillSessionAllowList?: SkillSessionAllowList,
): void {
  let scratchRegistered = false;
  ptyService.onSessionEvent((sid, event, data) => {
    if (sid !== sessionId) return;

    // Clear per-session skill allow-list on terminal events so the entry
    // doesn't linger after the PTY session is gone.
    if (
      skillSessionAllowList &&
      (event === "stopped" || event === "task_complete" || event === "error")
    ) {
      skillSessionAllowList.clear(sessionId);
    }

    // No chat messages on `blocked` or `task_complete` regardless of the
    // coordinatorActive flag. The SwarmCoordinator runs in parallel and
    // owns user-facing delivery: blocking prompts (Bypass Permissions,
    // trust dialogs, tool permissions) are auto-resolved within ~1s, and
    // the swarm-complete callback emits a single combined synthesis once
    // all swarm tasks reach terminal state. Posting per-agent
    // "Agent X completed the task" messages here produced noisy duplicate
    // chatter and a leak of raw subagent output before the synthesis ran,
    // most visibly when SPAWN_AGENT redirected a multi-intent prompt
    // through START_CODING_TASK and the first finished sub-agent fired its own
    // "completed" callback ahead of the combined synthesis.
    //
    // task_complete intentionally does NOT force-kill the session here:
    // it fires after every tool call when the prompt reappears, not only
    // when the agent is truly finished. Killing here would reap the agent
    // mid-work (e.g. after WebSearch but before composing the answer).
    // The session is cleaned up by the idle watchdog after 5 minutes of
    // real inactivity, or when the agent naturally exits.
    if (!coordinatorActive && event === "error" && callback) {
      callback({
        text: `Agent "${label}" encountered an error: ${(data as { message?: string }).message ?? "unknown error"}`,
      });
    }

    // Scratch lifecycle: register terminal scratch workspaces for retention
    // policy handling (ephemeral / pending_decision / persistent).
    if (
      (event === "stopped" || event === "task_complete" || event === "error") &&
      scratchDir &&
      !scratchRegistered
    ) {
      logger.info(
        `[scratch-lifecycle] Terminal event "${event}" for "${label}": registering scratch workspace at ${scratchDir}`,
      );
      const wsService = getCodingWorkspaceService(runtime);
      if (!wsService) {
        logger.warn(
          `[scratch-lifecycle] CODING_WORKSPACE_SERVICE not found, cannot register scratch workspace`,
        );
        // Leave scratchRegistered false so a later event can retry
      } else {
        wsService
          .registerScratchWorkspace(sessionId, scratchDir, label, event)
          .then(() => {
            scratchRegistered = true;
          })
          .catch((err: unknown) => {
            logger.warn(
              `[START_CODING_TASK] Failed to register scratch workspace for "${label}": ${err}`,
            );
            // Leave scratchRegistered false so a later event can retry
          });
      }
    }
  });
}
