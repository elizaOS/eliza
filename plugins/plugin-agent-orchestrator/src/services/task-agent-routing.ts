import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import { readConfigEnvKey } from "./config-env.js";

const KNOWN_ADAPTER_TYPES = new Set([
  "elizaos",
  "pi-agent",
  "claude",
  "codex",
  "opencode",
  "gemini",
  "aider",
  "hermes",
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
      return "elizaos";
    case "pi-agent":
    case "pi agent":
    case "pi":
      return "pi-agent";
    case "opencode":
    case "open-code":
    case "open code":
      return "opencode";
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
  if (opts.lockWorkdir && expandedExplicit && fs.existsSync(expandedExplicit)) {
    return { workdir: expandedExplicit };
  }
  const route = resolveWorkdirRoute(runtime, task, userRequest);
  if (route) return { workdir: route.workdir, route };
  // Auto-detect: when `TASK_AGENT_WORKDIR_ROOTS` is set (one or more
  // colon-separated base dirs, default `~/Projects`), look for an
  // immediate subdir whose name appears in the user request / task. This
  // is convention-over-configuration — no per-project route entry needed
  // as long as the project directory is named like the user refers to it.
  const detected = resolveWorkdirByConvention(runtime, task, userRequest);
  if (detected) return { workdir: detected };
  if (expandedExplicit && fs.existsSync(expandedExplicit)) {
    return { workdir: expandedExplicit };
  }
  const fallbackWorkdir = resolveDefaultSpawnWorkdir(runtime);
  if (expandedExplicit) {
    logger.warn(
      `[workdir-routes] Planner workdir does not exist, ignoring it: ${expandedExplicit} — falling back to ${fallbackWorkdir}`,
    );
  }
  return { workdir: fallbackWorkdir };
}

/**
 * Last-resort spawn cwd when a task matched no route/convention/explicit
 * workdir. Honors the documented default ACP workspace settings
 * (`ELIZA_ACP_WORKSPACE_ROOT` / `ACPX_DEFAULT_CWD` — the same ones
 * `AcpService.spawnSession` consults) so simple, non-repo tasks land in a
 * dedicated scratch dir instead of writing into the runtime's own source
 * checkout. Falls back to `process.cwd()` only when neither is configured,
 * preserving the run-in-place default for self-checkout workflows.
 */
function resolveDefaultSpawnWorkdir(
  runtime: IAgentRuntime | undefined,
): string {
  const configured =
    (typeof runtime?.getSetting === "function"
      ? ((runtime.getSetting("ELIZA_ACP_WORKSPACE_ROOT") as
          | string
          | undefined) ??
        (runtime.getSetting("ACPX_DEFAULT_CWD") as string | undefined))
      : undefined) ??
    readConfigEnvKey("ELIZA_ACP_WORKSPACE_ROOT") ??
    readConfigEnvKey("ACPX_DEFAULT_CWD");
  const trimmed = configured?.trim();
  return trimmed ? expandHomePath(trimmed) : process.cwd();
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
    const expanded = expandHomePath(route.workdir);
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
