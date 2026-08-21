/**
 * HTTP route handlers for the skill-management surface mounted under
 * /api/skills/*: workspace/marketplace skill CRUD, catalog install/uninstall,
 * security-scan acknowledgement, and enable/disable persistence. The agent's
 * HTTP server dispatches to these via `handleSkillsRoutes`.
 *
 * Enable/disable state persists in the agent database under a cache key;
 * workspace discovery resolves the agent workspace dir from ELIZA_WORKSPACE_DIR,
 * persisted folder config, cwd project markers, then the state dir.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import { type AgentRuntime, ElizaError, logger, readWorkspaceFolderConfig } from "@elizaos/core";
import type { ReadJsonBodyOptions } from "@elizaos/shared";
import {
  decodeUrlPathComponent,
  PostMarketplaceInstallRequestSchema,
  PostMarketplaceUninstallRequestSchema,
  PostSkillAcknowledgeRequestSchema,
  PostSkillCatalogInstallRequestSchema,
  PostSkillCatalogUninstallRequestSchema,
  PostSkillCreateRequestSchema,
  PutSkillSourceRequestSchema,
  parseClampedInteger,
  readAliasedEnv,
} from "@elizaos/shared";
import {
  type InstalledMarketplaceSkill,
  installMarketplaceSkill,
  listInstalledMarketplaceSkills,
  searchSkillsMarketplace,
  uninstallMarketplaceSkill,
} from "../services/skill-marketplace";
import { isSkillDownloadError } from "../services/skill-package-bytes";
import {
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_NAME_MAX_LENGTH,
  SKILL_NAME_PATTERN,
} from "../types";
import { skillScaffoldMarkdown } from "./skill-scaffold";

const WORKSPACE_MARKERS = [
  "AGENTS.md",
  "CLAUDE.md",
  "package.json",
  "skills",
  ".git",
] as const;

function resolveUserPath(value: string): string {
  const trimmed = value.trim();
  if (trimmed === "~") return os.homedir();
  if (trimmed.startsWith("~/")) return path.join(os.homedir(), trimmed.slice(2));
  return path.resolve(trimmed);
}

function shouldUseRuntimeCwdWorkspace(candidateDir: string): boolean {
  const resolvedDir = resolveUserPath(candidateDir);
  const normalized = resolvedDir.replace(/\\/g, "/").toLowerCase();
  if (
    normalized.includes("/eliza-dist") ||
    normalized.includes("/contents/resources/app/") ||
    normalized.includes("/resources/app/") ||
    normalized.includes("/self-extraction/")
  ) {
    return false;
  }
  return WORKSPACE_MARKERS.some((marker) =>
    fs.existsSync(path.join(resolvedDir, marker)),
  );
}

function resolveDefaultAgentWorkspaceDir(): string {
  const explicit = process.env.ELIZA_WORKSPACE_DIR?.trim();
  if (explicit) return resolveUserPath(explicit);

  try {
    const persisted = readWorkspaceFolderConfig(process.env);
    if (persisted?.path?.trim()) return resolveUserPath(persisted.path);
  } catch {
    // Fall through to cwd / state-dir defaults.
  }

  if (!readAliasedEnv("ELIZA_STATE_DIR")) {
    const cwd = process.cwd();
    if (cwd.trim() && shouldUseRuntimeCwdWorkspace(cwd)) {
      return resolveUserPath(cwd);
    }
  }

  const stateDir = resolveUserPath(
    readAliasedEnv("ELIZA_STATE_DIR") ?? path.join(os.homedir(), ".eliza"),
  );
  const profile = process.env.ELIZA_PROFILE?.trim();
  if (profile && profile.toLowerCase() !== "default") {
    return path.join(stateDir, `workspace-${profile}`);
  }
  return path.join(stateDir, "workspace");
}

/**
 * Minimal structural shape of the agent's on-disk config used by the
 * skills routes. Avoids a hard type dependency on `@elizaos/agent`'s
 * private `ElizaConfig` shape — the route handlers only ever touch the
 * fields below.
 */
export interface ElizaSkillConfigEntry {
  enabled?: boolean;
  [key: string]: unknown;
}

export interface ElizaConfig {
  agents?: {
    defaults?: {
      workspace?: string;
    };
  };
  env?: Record<string, unknown>;
  skills?: {
    denyBundled?: string[];
    allowBundled?: string[];
    entries?: Record<string, ElizaSkillConfigEntry>;
    load?: {
      extraDirs?: string[];
    };
  };
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Types shared with server.ts (kept lean to avoid circular deps)
// ---------------------------------------------------------------------------

export interface SkillEntry {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  scanStatus?: "clean" | "warning" | "critical" | "blocked" | null;
}

export interface SkillsRouteContext {
  req: http.IncomingMessage;
  res: http.ServerResponse;
  method: string;
  pathname: string;
  url: URL;
  state: SkillsServerState;
  // Helpers from server.ts
  json: (res: http.ServerResponse, data: unknown, status?: number) => void;
  error: (res: http.ServerResponse, message: string, status?: number) => void;
  readJsonBody: <T extends object>(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    options?: ReadJsonBodyOptions,
  ) => Promise<T | null>;
  readBody: (req: http.IncomingMessage) => Promise<string>;
  /**
   * @deprecated Retained for source compatibility with older Agent hosts.
   * Route identifiers are decoded internally and this callback is ignored.
   */
  decodePathComponent?: (
    raw: string,
    res: http.ServerResponse,
    fieldName: string,
  ) => string | null;
  // Functions from server.ts that skills routes need
  discoverSkills: (
    workspaceDir: string,
    config: ElizaConfig,
    runtime: AgentRuntime | null,
  ) => Promise<SkillEntry[]>;
}

export interface SkillsServerState {
  runtime: AgentRuntime | null;
  config: ElizaConfig;
  skills: SkillEntry[];
}

interface InstallRequestLifecycle {
  readonly signal: AbortSignal;
  markCompleted(): void;
  dispose(): void;
}

function skillInstallHttpStatus(cause: unknown): number {
  if (!isSkillDownloadError(cause)) return 500;
  if (cause.code === "SKILL_DOWNLOAD_TIMEOUT") return 504;
  if (cause.code === "SKILL_DOWNLOAD_ABORTED") return 499;
  if (cause.code === "SKILL_PACKAGE_TOO_LARGE") return 413;
  return 422;
}

function respondToSkillInstallError(
  ctx: Pick<SkillsRouteContext, "json" | "error" | "res">,
  prefix: string,
  cause: unknown,
): void {
  if (isSkillDownloadError(cause)) {
    ctx.json(
      ctx.res,
      { error: `${prefix}: ${cause.message}`, code: cause.code },
      skillInstallHttpStatus(cause),
    );
    return;
  }
	if (cause instanceof ElizaError) {
		const status =
			cause.code === "SKILL_MARKETPLACE_INVALID_INPUT"
				? 400
				: cause.code === "SKILL_MARKETPLACE_ALREADY_INSTALLED"
					? 409
					: cause.code === "SKILL_MARKETPLACE_NOT_FOUND"
						? 404
						: cause.code === "SKILL_MARKETPLACE_SECURITY_BLOCKED"
							? 422
							: null;
		if (status !== null) {
			ctx.json(
				ctx.res,
				{ error: `${prefix}: ${cause.message}`, code: cause.code },
				status,
			);
			return;
		}
	}
  ctx.error(ctx.res, prefix, 500);
}

function publicMarketplaceSkill(
  record: InstalledMarketplaceSkill,
): Omit<InstalledMarketplaceSkill, "installPath"> {
  const { installPath: _installPath, ...publicRecord } = record;
  return publicRecord;
}

function prepareWorkspaceSkillRemoval(
  workspaceDir: string,
  skillId: string,
): { rollback(): void; finalize(): void } {
  const workspaceRoot = path.resolve(workspaceDir);
  const skillsRoot = path.join(workspaceRoot, "skills");
  const target = path.join(skillsRoot, skillId);
  for (const parent of [workspaceRoot, skillsRoot]) {
    const stat = fs.lstatSync(parent);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new ElizaError("Workspace skill removal failed the safety policy", {
        code: "SKILL_MARKETPLACE_SECURITY_BLOCKED",
        context: { skillId },
      });
    }
  }
  const targetStat = fs.lstatSync(target);
  if (
    targetStat.isSymbolicLink() ||
    !targetStat.isDirectory() ||
    fs.realpathSync(path.dirname(target)) !== fs.realpathSync(skillsRoot)
  ) {
    throw new ElizaError("Workspace skill removal failed the safety policy", {
      code: "SKILL_MARKETPLACE_SECURITY_BLOCKED",
      context: { skillId },
    });
  }
	const stagingDir = fs.mkdtempSync(path.join(skillsRoot, ".delete-"));
	const retainedPath = path.join(stagingDir, "skill");
	fs.renameSync(target, retainedPath);
	let finished = false;
	return {
		rollback(): void {
			if (finished) return;
			fs.renameSync(retainedPath, target);
			fs.rmSync(stagingDir, { recursive: true, force: true });
			finished = true;
		},
		finalize(): void {
			if (finished) return;
			fs.rmSync(stagingDir, { recursive: true, force: true });
			finished = true;
		},
	};
}

type AbortEventSource = {
  on?: (event: string, listener: () => void) => unknown;
  off?: (event: string, listener: () => void) => unknown;
};

function createInstallRequestLifecycle(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): InstallRequestLifecycle {
  const controller = new AbortController();
  const registrations: Array<{
    source: AbortEventSource;
    event: string;
    listener: () => void;
  }> = [];
  let completed = false;
  const abort = (): void => {
    if (!completed && !controller.signal.aborted) {
      controller.abort(new Error("Skill install client disconnected"));
    }
  };
  const register = (
    source: AbortEventSource | null | undefined,
    event: string,
    listener: () => void,
  ): void => {
    if (typeof source?.on !== "function") return;
    source.on(event, listener);
    registrations.push({ source, event, listener });
  };
  const onResponseClose = (): void => {
    if (!res.writableEnded) abort();
  };

  register(req, "aborted", abort);
  register(req, "error", abort);
  register(res, "close", onResponseClose);
  register(res, "error", abort);
  register(req.socket, "close", abort);
  register(req.socket, "error", abort);
  if (req.aborted || req.destroyed || res.destroyed) abort();

  return {
    signal: controller.signal,
    markCompleted(): void {
      completed = true;
    },
    dispose(): void {
      for (const { source, event, listener } of registrations) {
        source.off?.(event, listener);
      }
      registrations.length = 0;
    },
  };
}

async function refreshAfterCommittedSkillMutation(
  state: SkillsServerState,
  workspaceDir: string,
  scope: string,
	discover: SkillsRouteContext["discoverSkills"],
	_signal?: AbortSignal,
): Promise<void> {
  try {
		const nextSkills = await discover(
      workspaceDir,
      state.config,
      state.runtime,
    );
		state.skills = nextSkills;
  } catch (error) {
    // error-policy:J7 A committed mutation remains successful when its
    // post-commit view refresh fails; diagnostics make the stale view visible.
    state.runtime?.reportError(scope, error, { workspaceDir });
    logger.warn(
      `[skills-api] Post-commit skill refresh failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function refreshMarketplaceRuntimeSkill(
  state: SkillsServerState,
  slug: string,
): Promise<void> {
  try {
    const service = state.runtime?.getService("AGENT_SKILLS_SERVICE") as
      | { refreshMarketplaceSkill?: (slug: string) => Promise<void> }
      | undefined;
    await service?.refreshMarketplaceSkill?.(slug);
  } catch (error) {
    // error-policy:J7 The marketplace filesystem commit is authoritative;
    // runtime reconciliation failure is diagnostic and must not invite retry.
    state.runtime?.reportError("SkillsRoute.marketplaceRuntimeRefresh", error, {
      slug,
    });
  }
}

// ---------------------------------------------------------------------------
// Skill ID validation
// ---------------------------------------------------------------------------

const SAFE_SKILL_ID_RE = /^[a-zA-Z0-9._-]+$/;

const SCAFFOLD_FALLBACK_DESCRIPTION = "Describe what this skill does.";

/**
 * Normalize a user-supplied skill description to the exact string that should be
 * stored in the scaffold's `description:` frontmatter field.
 *
 * Trimming yields the stored value; an all-whitespace description falls back to
 * the scaffold default so the required field never renders blank. This function
 * deliberately does no lossy rewriting — quote/backslash/newline/coercion safety
 * is handled at serialization time by {@link serializeScaffoldDescription},
 * which emits an unambiguously quoted scalar. Kept exported for the round-trip
 * regression test.
 */
export function sanitizeScaffoldDescription(description: string): string {
  const trimmed = description.trim();
  return trimmed || SCAFFOLD_FALLBACK_DESCRIPTION;
}

/**
 * Serialize a description into an unambiguously double-quoted YAML scalar for
 * the scaffold's `description:` field.
 *
 * `JSON.stringify` emits a JSON string literal — a valid YAML double-quoted flow
 * scalar — with quotes, backslashes, C0 controls, and lone surrogates escaped.
 * JavaScript line/paragraph separators are escaped explicitly because JSON
 * permits them literally while the filesystem discovery regex treats them as
 * line boundaries. Because the value is quoted, `parseFrontmatter` never coerces
 * it to a boolean/number/null/object/array (which would make `toSkillFrontmatter`
 * reject the skill for having a non-string description) and cannot be tricked
 * into parsing embedded newlines as extra frontmatter keys. The parser decodes
 * the same literal via `decodeFrontmatterScalarString`, so the stored
 * description round-trips back to `sanitizeScaffoldDescription(input)` exactly.
 *
 * `JSON.stringify` leaves U+2028 LINE SEPARATOR and U+2029 PARAGRAPH SEPARATOR
 * literal, but JavaScript regexes treat both as line terminators — so the
 * discovery scan's single-line `description:` match (`scanSkillsDir`) would
 * truncate a scalar containing either character and disagree with the canonical
 * parser. They are escaped to their `\uXXXX` forms, which remain valid JSON
 * (and therefore YAML double-quoted) escapes that `decodeFrontmatterScalarString`
 * decodes back to the exact source character.
 */
export function serializeScaffoldDescription(description: string): string {
  return JSON.stringify(sanitizeScaffoldDescription(description))
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function validateSkillId(
  skillId: string,
  res: http.ServerResponse,
  errorFn: SkillsRouteContext["error"],
): string | null {
  if (
    !skillId ||
    skillId.length > SKILL_NAME_MAX_LENGTH ||
    !SAFE_SKILL_ID_RE.test(skillId) ||
    skillId === "." ||
    skillId.includes("..")
  ) {
    const safeDisplay = skillId.slice(0, 80).replace(/[^\x20-\x7e]/g, "?");
    errorFn(res, `Invalid skill ID: "${safeDisplay}"`, 400);
    return null;
  }
  return skillId;
}

function decodeAndValidateSkillId(
  rawSkillId: string,
  res: http.ServerResponse,
  errorFn: SkillsRouteContext["error"],
): string | null {
  const decoded = decodeUrlPathComponent(rawSkillId);
  if (!decoded.ok) {
    // error-policy:J3 untrusted-input sanitizing — malformed percent-encoding is invalid client input.
    errorFn(res, "Invalid skill ID: malformed URL encoding", 400);
    return null;
  }
  return validateSkillId(decoded.value, res, errorFn);
}

function isValidCatalogSkillSlug(slug: string): boolean {
  return slug.length <= SKILL_NAME_MAX_LENGTH && SKILL_NAME_PATTERN.test(slug);
}

// ---------------------------------------------------------------------------
// Binance skill filtering
// ---------------------------------------------------------------------------

const EXPOSED_BINANCE_SKILL_IDS = new Set([
  "binance-crypto-market-rank",
  "binance-meme-rush",
  "binance-query-address-info",
  "binance-query-token-audit",
  "binance-query-token-info",
  "binance-trading-signal",
]);

function shouldExposeBinanceSkillId(skillId: string): boolean {
  const normalized = skillId.trim();
  if (!normalized.startsWith("binance-")) return true;
  return EXPOSED_BINANCE_SKILL_IDS.has(normalized);
}

function shouldExposeBinanceSkillRecord(skill: {
  id?: unknown;
  slug?: unknown;
}): boolean {
  const slug = typeof skill.slug === "string" ? skill.slug.trim() : "";
  if (slug) return shouldExposeBinanceSkillId(slug);
  const id = typeof skill.id === "string" ? skill.id.trim() : "";
  if (id) return shouldExposeBinanceSkillId(id);
  return true;
}

// ---------------------------------------------------------------------------
// Skill preferences (per-agent, persisted in agent database)
// ---------------------------------------------------------------------------

const SKILL_PREFS_CACHE_KEY = "eliza:skill-preferences";
type SkillPreferencesMap = Record<string, boolean>;

// An empty map means "none persisted yet" (the `?? {}` below); a cache read
// *failure* propagates. Callers read-modify-write this map before saving it
// back, so masking a transient DB error as `{}` would overwrite every other
// skill's saved preference — the read failure must surface, not read as empty.
async function loadSkillPreferences(
  runtime: AgentRuntime | null,
): Promise<SkillPreferencesMap> {
  if (!runtime) return {};
  const prefs = await runtime.getCache<SkillPreferencesMap>(
    SKILL_PREFS_CACHE_KEY,
  );
  return prefs ?? {};
}

async function saveSkillPreferences(
  runtime: AgentRuntime,
  prefs: SkillPreferencesMap,
): Promise<void> {
  try {
    await runtime.setCache(SKILL_PREFS_CACHE_KEY, prefs);
  } catch (err) {
    logger.debug(
      `[eliza-api] Failed to save skill preferences: ${err instanceof Error ? err.message : err}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Skill scan acknowledgments
// ---------------------------------------------------------------------------

const SKILL_ACK_CACHE_KEY = "eliza:skill-scan-acknowledgments";

type SkillAcknowledgmentMap = Record<
  string,
	{ acknowledgedAt: string; findingCount: number; reportDigest: string }
>;

function skillScanReportDigest(report: Record<string, unknown>): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				scannedAt: report.scannedAt,
				status: report.status,
				findings: report.findings,
				manifestFindings: report.manifestFindings,
			}),
		)
		.digest("hex");
}

// Same contract as loadSkillPreferences: `{}` means "none acknowledged yet"; a
// cache read failure propagates rather than being merged over and saved back as
// an acknowledgment wipe.
async function loadSkillAcknowledgments(
  runtime: AgentRuntime | null,
): Promise<SkillAcknowledgmentMap> {
  if (!runtime) return {};
  const acks =
    await runtime.getCache<SkillAcknowledgmentMap>(SKILL_ACK_CACHE_KEY);
  return acks ?? {};
}

// ---------------------------------------------------------------------------
// Scan report loading
// ---------------------------------------------------------------------------

async function loadScanReportFromDisk(
  skillId: string,
  workspaceDir: string,
  runtime?: AgentRuntime | null,
): Promise<Record<string, unknown> | null> {
  const candidates = [
    path.join(workspaceDir, "skills", skillId, ".scan-results.json"),
    path.join(
      workspaceDir,
      "skills",
      ".marketplace",
      skillId,
      ".scan-results.json",
    ),
  ];

  if (runtime) {
    const svc = runtime.getService("AGENT_SKILLS_SERVICE") as
      | { getLoadedSkills?: () => Array<{ slug: string; path: string }> }
      | undefined;
    if (svc?.getLoadedSkills) {
      const loaded = svc.getLoadedSkills().find((s) => s.slug === skillId);
      if (loaded?.path) {
        candidates.push(path.join(loaded.path, ".scan-results.json"));
      }
    }
  }

  const seen = new Set<string>();
  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    if (!fs.existsSync(resolved)) continue;
    const content = fs.readFileSync(resolved, "utf-8");
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(content) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (
      typeof parsed.scannedAt === "string" &&
      typeof parsed.status === "string" &&
      Array.isArray(parsed.findings) &&
      Array.isArray(parsed.manifestFindings)
    ) {
      return parsed as Record<string, unknown>;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleSkillsRoutes(
  ctx: SkillsRouteContext,
): Promise<boolean> {
  const {
    req,
    res,
    method,
    pathname,
    url,
    state,
    json,
    error,
    readJsonBody,
    discoverSkills,
  } = ctx;

  // ── GET /api/skills/catalog ───────────────────────────────────────────
  // Browse the full skill catalog (paginated).
  if (method === "GET" && pathname === "/api/skills/catalog") {
    try {
      const { getCatalogSkills } = await import(
        "../services/skill-catalog-client"
      );
      const all = (await getCatalogSkills()).filter((skill) =>
        shouldExposeBinanceSkillRecord(skill),
      );
      const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
      const perPage = Math.min(
        100,
        Math.max(1, Number(url.searchParams.get("perPage")) || 50),
      );
      const sort = url.searchParams.get("sort") ?? "downloads";
      const sorted = [...all];
      if (sort === "downloads")
        sorted.sort(
          (a, b) =>
            b.stats.downloads - a.stats.downloads || b.updatedAt - a.updatedAt,
        );
      else if (sort === "stars")
        sorted.sort(
          (a, b) => b.stats.stars - a.stats.stars || b.updatedAt - a.updatedAt,
        );
      else if (sort === "updated")
        sorted.sort((a, b) => b.updatedAt - a.updatedAt);
      else if (sort === "name")
        sorted.sort((a, b) =>
          (a.displayName).localeCompare(b.displayName),
        );

      // Resolve installed status from the AgentSkillsService
      const installedSlugs = new Set<string>();
      if (state.runtime) {
        try {
          const svc = state.runtime.getService("AGENT_SKILLS_SERVICE") as
            | {
                getLoadedSkills?: () => Array<{ slug: string; source: string }>;
              }
            | undefined;
          if (svc && typeof svc.getLoadedSkills === "function") {
            for (const s of svc.getLoadedSkills()) {
              if (!shouldExposeBinanceSkillId(s.slug)) continue;
              installedSlugs.add(s.slug);
            }
          }
        } catch (err) {
          logger.debug(
            `[api] Service not available: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
      // Also check locally discovered skills
      for (const s of state.skills) {
        installedSlugs.add(s.id);
      }

      const start = (page - 1) * perPage;
      const skills = sorted.slice(start, start + perPage).map((s) => ({
        ...s,
        installed: installedSlugs.has(s.slug),
      }));
      json(res, {
        total: all.length,
        page,
        perPage,
        totalPages: Math.ceil(all.length / perPage),
        installedCount: installedSlugs.size,
        skills,
      });
    } catch (err) {
      error(
        res,
        `Failed to load skill catalog: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return true;
  }

  // ── GET /api/skills/catalog/search ─────────────────────────────────────
  if (method === "GET" && pathname === "/api/skills/catalog/search") {
    const q = url.searchParams.get("q");
    if (!q) {
      error(res, "Missing query parameter ?q=", 400);
      return true;
    }
    try {
      const { searchCatalogSkills } = await import(
        "../services/skill-catalog-client"
      );
      const limit = Math.min(
        100,
        Math.max(1, Number(url.searchParams.get("limit")) || 30),
      );
      const results = (await searchCatalogSkills(q, limit)).filter((skill) =>
        shouldExposeBinanceSkillRecord(skill),
      );
      json(res, { query: q, count: results.length, results });
    } catch (err) {
      error(
        res,
        `Skill catalog search failed: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return true;
  }

  // ── GET /api/skills/catalog/:slug ──────────────────────────────────────
  if (method === "GET" && pathname.startsWith("/api/skills/catalog/")) {
    const decoded = decodeUrlPathComponent(
      pathname.slice("/api/skills/catalog/".length),
    );
    if (!decoded.ok) {
      // error-policy:J3 untrusted-input sanitizing — malformed percent-encoding is invalid client input
      error(res, "Invalid skill slug: malformed URL encoding", 400);
      return true;
    }
    const slug = decoded.value;
    if (!isValidCatalogSkillSlug(slug)) {
      error(res, "Invalid skill slug", 400);
      return true;
    }
    // Exclude "search" which is handled above
    if (slug && slug !== "search") {
      if (!shouldExposeBinanceSkillId(slug)) {
        error(res, `Skill "${slug}" not found in catalog`, 404);
        return true;
      }
      try {
        const { getCatalogSkill } = await import(
          "../services/skill-catalog-client"
        );
        const skill = await getCatalogSkill(slug);
        if (!skill) {
          error(res, `Skill "${slug}" not found in catalog`, 404);
          return true;
        }
        json(res, { skill });
      } catch (err) {
        error(
          res,
          `Failed to fetch skill: ${err instanceof Error ? err.message : String(err)}`,
          500,
        );
      }
      return true;
    }
  }

  // ── POST /api/skills/catalog/refresh ───────────────────────────────────
  // First triggers the remote registry sync (via AgentSkillsService), then
  // re-reads the local catalog file. This ensures the UI gets fresh data
  // from the remote marketplace (clawhub.ai or configured registryUrl).
  if (method === "POST" && pathname === "/api/skills/catalog/refresh") {
    try {
      // Trigger remote sync if the runtime + skills service are available
      if (state.runtime) {
        const svc = state.runtime.getService("AGENT_SKILLS_SERVICE") as
          | { syncCatalog?: () => Promise<unknown> }
          | undefined;
        if (svc?.syncCatalog) {
          await svc.syncCatalog();
        }
      }
      // Then re-read the now-updated local catalog file
      const { refreshCatalog } = await import(
        "../services/skill-catalog-client"
      );
      const skills = await refreshCatalog();
      json(res, { ok: true, count: skills.length });
    } catch (err) {
      error(
        res,
        `Catalog refresh failed: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return true;
  }

  // ── POST /api/skills/catalog/install ───────────────────────────────────
  if (method === "POST" && pathname === "/api/skills/catalog/install") {
    const raw = await readJsonBody<Record<string, unknown>>(req, res);
    if (raw === null) return true;
    const parsed = PostSkillCatalogInstallRequestSchema.safeParse(raw);
    if (!parsed.success) {
      error(
        res,
        parsed.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    const body = parsed.data;

    if (!state.runtime) {
      error(res, "Agent runtime not available — start the agent first", 503);
      return true;
    }

    try {
      const service = state.runtime.getService("AGENT_SKILLS_SERVICE") as
        | {
            install?: (
              slug: string,
              opts?: {
                version?: string;
                force?: boolean;
                signal?: AbortSignal;
                throwOnDownloadError?: boolean;
              },
            ) => Promise<boolean>;
            isInstalled?: (slug: string) => Promise<boolean>;
          }
        | undefined;

      if (!service || typeof service.install !== "function") {
        error(
          res,
          "AgentSkillsService not available — ensure @elizaos/plugin-agent-skills is loaded",
          501,
        );
        return true;
      }

      const requestLifecycle = createInstallRequestLifecycle(req, res);
      try {
        const alreadyInstalled =
          typeof service.isInstalled === "function"
            ? await service.isInstalled(body.slug)
            : false;
        requestLifecycle.signal.throwIfAborted();

        if (alreadyInstalled) {
          json(res, {
            ok: true,
            slug: body.slug,
            message: `Skill "${body.slug}" is already installed`,
            alreadyInstalled: true,
          });
          requestLifecycle.markCompleted();
          return true;
        }

        const success = await service.install(body.slug, {
          version: body.version,
          signal: requestLifecycle.signal,
          throwOnDownloadError: true,
        });

        if (success) {
          // Refresh the skills list so the UI picks up the new skill
          const workspaceDir =
            state.config.agents?.defaults?.workspace ??
            resolveDefaultAgentWorkspaceDir();
					await refreshAfterCommittedSkillMutation(
						state,
						workspaceDir,
						"SkillsRoute.catalogInstallRefresh",
						discoverSkills,
						requestLifecycle.signal,
					);
					requestLifecycle.signal.throwIfAborted();

          json(res, {
            ok: true,
            slug: body.slug,
            message: `Skill "${body.slug}" installed successfully`,
          });
        } else {
          error(res, `Failed to install skill "${body.slug}"`, 500);
        }
        requestLifecycle.markCompleted();
      } catch (cause) {
        // error-policy:J1 a disconnected HTTP request owns cancellation and
        // must not receive a late response from the completed install path.
        if (requestLifecycle.signal.aborted) return true;
        throw cause;
      } finally {
        requestLifecycle.dispose();
      }
    } catch (err) {
      // error-policy:J1 the HTTP boundary translates typed install failures to
      // the established structured error response.
      respondToSkillInstallError(ctx, "Skill install failed", err);
    }
    return true;
  }

  // ── POST /api/skills/catalog/uninstall ─────────────────────────────────
  if (method === "POST" && pathname === "/api/skills/catalog/uninstall") {
    const raw = await readJsonBody<Record<string, unknown>>(req, res);
    if (raw === null) return true;
    const parsed = PostSkillCatalogUninstallRequestSchema.safeParse(raw);
    if (!parsed.success) {
      error(
        res,
        parsed.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    const body = parsed.data;

    if (!state.runtime) {
      error(res, "Agent runtime not available — start the agent first", 503);
      return true;
    }

    const requestLifecycle = createInstallRequestLifecycle(req, res);
    try {
      const service = state.runtime.getService("AGENT_SKILLS_SERVICE") as
        | {
            uninstall?: (
              slug: string,
              options?: { signal?: AbortSignal },
            ) => Promise<boolean>;
          }
        | undefined;

      if (!service || typeof service.uninstall !== "function") {
        error(
          res,
          "AgentSkillsService not available — ensure @elizaos/plugin-agent-skills is loaded",
          501,
        );
        return true;
      }

      const success = await service.uninstall(body.slug, {
        signal: requestLifecycle.signal,
      });

      if (success) {
        // Refresh the skills list
        const workspaceDir =
          state.config.agents?.defaults?.workspace ??
          resolveDefaultAgentWorkspaceDir();
				await refreshAfterCommittedSkillMutation(
					state,
					workspaceDir,
					"SkillsRoute.catalogUninstallRefresh",
					discoverSkills,
					requestLifecycle.signal,
				);
				requestLifecycle.signal.throwIfAborted();

        json(res, {
          ok: true,
          slug: body.slug,
          message: `Skill "${body.slug}" uninstalled successfully`,
        });
      } else {
        error(
          res,
          `Failed to uninstall skill "${body.slug}" — it may be a bundled skill`,
          404,
        );
      }
			requestLifecycle.markCompleted();
    } catch (err) {
      if (requestLifecycle.signal.aborted) return true;
      respondToSkillInstallError(ctx, "Skill uninstall failed", err);
    } finally {
      requestLifecycle.dispose();
    }
    return true;
  }

  // ── GET /api/skills ─────────────────────────────────────────────────────
  if (method === "GET" && pathname === "/api/skills") {
    json(res, { skills: state.skills });
    return true;
  }

  // ── POST /api/skills/refresh ──────────────────────────────────────────
  if (method === "POST" && pathname === "/api/skills/refresh") {
    try {
      const workspaceDir =
        state.config.agents?.defaults?.workspace ??
        resolveDefaultAgentWorkspaceDir();
      state.skills = await discoverSkills(
        workspaceDir,
        state.config,
        state.runtime,
      );
      json(res, { ok: true, skills: state.skills });
    } catch (err) {
      error(
        res,
        `Failed to refresh skills: ${err instanceof Error ? err.message : err}`,
        500,
      );
    }
    return true;
  }

  // ── GET /api/skills/:id/scan ───────────────────────────────────────────
  if (method === "GET" && pathname.match(/^\/api\/skills\/[^/]+\/scan$/)) {
    const skillId = decodeAndValidateSkillId(
      pathname.split("/")[3],
      res,
      error,
    );
    if (!skillId) return true;
    const workspaceDir =
      state.config.agents?.defaults?.workspace ??
      resolveDefaultAgentWorkspaceDir();
    const report = await loadScanReportFromDisk(
      skillId,
      workspaceDir,
      state.runtime,
    );
    const acks = await loadSkillAcknowledgments(state.runtime);
    const ack = acks[skillId] ?? null;
		const acknowledged =
			!!report && !!ack && ack.reportDigest === skillScanReportDigest(report);
		json(res, {
			ok: true,
			report,
			acknowledged,
			acknowledgment: acknowledged ? ack : null,
		});
    return true;
  }

  // ── POST /api/skills/:id/acknowledge ──────────────────────────────────
  if (
    method === "POST" &&
    pathname.match(/^\/api\/skills\/[^/]+\/acknowledge$/)
  ) {
    const skillId = decodeAndValidateSkillId(
      pathname.split("/")[3],
      res,
      error,
    );
    if (!skillId) return true;
    const rawAck = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawAck === null) return true;
    const parsedAck = PostSkillAcknowledgeRequestSchema.safeParse(rawAck);
    if (!parsedAck.success) {
      error(
        res,
        parsedAck.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    const body = parsedAck.data;

    const workspaceDir =
      state.config.agents?.defaults?.workspace ??
      resolveDefaultAgentWorkspaceDir();
    const report = await loadScanReportFromDisk(
      skillId,
      workspaceDir,
      state.runtime,
    );
    if (!report) {
      error(res, `No scan report found for skill "${skillId}".`, 404);
      return true;
    }
    if (report.status === "blocked") {
      error(
        res,
        `Skill "${skillId}" is blocked and cannot be acknowledged.`,
        403,
      );
      return true;
    }
    if (report.status === "clean") {
      json(res, {
        ok: true,
        message: "No findings to acknowledge.",
        acknowledged: true,
      });
      return true;
    }

    const findings = report.findings as Array<Record<string, unknown>>;
    const manifestFindings = report.manifestFindings as Array<
      Record<string, unknown>
    >;
    const totalFindings = findings.length + manifestFindings.length;
		const reportDigest = skillScanReportDigest(report);

		if (state.runtime) {
			const previousAcks = await loadSkillAcknowledgments(state.runtime);
			const nextAcks = {
				...previousAcks,
				[skillId]: {
					acknowledgedAt: new Date().toISOString(),
					findingCount: totalFindings,
					reportDigest,
				},
			};
			const previousPrefs = await loadSkillPreferences(state.runtime);
			const nextPrefs =
				body.enable === true
					? { ...previousPrefs, [skillId]: true }
					: previousPrefs;
			try {
				await state.runtime.setCache(SKILL_ACK_CACHE_KEY, nextAcks);
				if (body.enable === true) {
					await state.runtime.setCache(SKILL_PREFS_CACHE_KEY, nextPrefs);
				}
				const service = state.runtime.getService("AGENT_SKILLS_SERVICE") as
					| {
							acknowledgeSkillScan?: (
								slug: string,
								reportDigest: string,
							) => boolean;
							setSkillEnabled?: (
								slug: string,
								enabled: boolean,
								options?: { reportDigest?: string },
							) => boolean;
						}
					| undefined;
				if (service?.acknowledgeSkillScan?.(skillId, reportDigest) === false) {
					throw new Error("Runtime rejected the scan acknowledgment");
				}
				if (
					body.enable === true &&
					service?.setSkillEnabled?.(skillId, true, { reportDigest }) === false
				) {
					throw new Error("Runtime rejected skill enablement");
				}
			} catch (cause) {
				await Promise.all([
					state.runtime.setCache(SKILL_ACK_CACHE_KEY, previousAcks),
					state.runtime.setCache(SKILL_PREFS_CACHE_KEY, previousPrefs),
				]);
				error(res, "Failed to persist skill acknowledgment", 500);
				state.runtime.reportError("SkillsRoute.acknowledge", cause, { skillId });
				return true;
			}
		}

		if (body.enable === true) {
			const skill = state.skills.find((s) => s.id === skillId);
			if (skill) skill.enabled = true;
		}

    json(res, {
      ok: true,
      skillId,
      acknowledged: true,
      enabled: body.enable === true,
      findingCount: totalFindings,
    });
    return true;
  }

  // ── POST /api/skills/create ───────────────────────────────────────────
  if (method === "POST" && pathname === "/api/skills/create") {
    const rawCreate = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawCreate === null) return true;
    const parsedCreate = PostSkillCreateRequestSchema.safeParse(rawCreate);
    if (!parsedCreate.success) {
      error(
        res,
        parsedCreate.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    const body = parsedCreate.data;

    const slug = body.name
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!slug || slug.length > 64) {
      error(
        res,
        "Skill name must produce a valid slug (1-64 chars, lowercase alphanumeric + hyphens)",
        400,
      );
      return true;
    }

    const description = body.description ?? SCAFFOLD_FALLBACK_DESCRIPTION;
    const safeDescription = sanitizeScaffoldDescription(description);
    if (safeDescription.length > SKILL_DESCRIPTION_MAX_LENGTH) {
      error(
        res,
        `Skill description must be ${SKILL_DESCRIPTION_MAX_LENGTH} characters or less`,
        400,
      );
      return true;
    }

    const workspaceDir =
      state.config.agents?.defaults?.workspace ??
      resolveDefaultAgentWorkspaceDir();
    const skillDir = path.join(workspaceDir, "skills", slug);

    if (fs.existsSync(skillDir)) {
      error(res, `Skill "${slug}" already exists`, 409);
      return true;
    }

    const descriptionScalar = serializeScaffoldDescription(safeDescription);
    const template = skillScaffoldMarkdown
      .replace(/__SLUG__/g, slug)
      // Use a function replacer so any `$`-sequence produced by JSON string
      // escaping (or a literal `$&`/`$1` inside the description) is inserted
      // verbatim rather than treated as a replacement pattern by
      // String.prototype.replace.
      .replace(/__DESCRIPTION__/g, () => descriptionScalar);

    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), template, "utf-8");

    state.skills = await discoverSkills(
      workspaceDir,
      state.config,
      state.runtime,
    );
    const skill = state.skills.find((s) => s.id === slug);
    json(res, {
      ok: true,
      skill: skill ?? {
        id: slug,
        name: slug,
        description: safeDescription,
        enabled: true,
      },
      path: skillDir,
    });
    return true;
  }

  // ── POST /api/skills/:id/open ─────────────────────────────────────────
  if (method === "POST" && pathname.match(/^\/api\/skills\/[^/]+\/open$/)) {
    const skillId = decodeAndValidateSkillId(
      pathname.split("/")[3],
      res,
      error,
    );
    if (!skillId) return true;
    const workspaceDir =
      state.config.agents?.defaults?.workspace ??
      resolveDefaultAgentWorkspaceDir();

    const candidates = [
      path.join(workspaceDir, "skills", skillId),
      path.join(workspaceDir, "skills", ".marketplace", skillId),
    ];
    let skillPath: string | null = null;
    for (const c of candidates) {
      if (fs.existsSync(path.join(c, "SKILL.md"))) {
        skillPath = c;
        break;
      }
    }

    // Try AgentSkillsService for bundled skills — copy to workspace for editing
    if (!skillPath && state.runtime) {
      try {
        const svc = state.runtime.getService("AGENT_SKILLS_SERVICE") as
          | {
              getLoadedSkills?: () => Array<{
                slug: string;
                path: string;
                source: string;
              }>;
            }
          | undefined;
        if (svc?.getLoadedSkills) {
          const loaded = svc.getLoadedSkills().find((s) => s.slug === skillId);
          if (loaded) {
            if (loaded.source === "bundled" || loaded.source === "plugin") {
              const targetDir = path.join(workspaceDir, "skills", skillId);
              if (!fs.existsSync(targetDir)) {
                fs.cpSync(loaded.path, targetDir, { recursive: true });
                state.skills = await discoverSkills(
                  workspaceDir,
                  state.config,
                  state.runtime,
                );
              }
              skillPath = targetDir;
            } else {
              skillPath = loaded.path;
            }
          }
        }
      } catch (err) {
        logger.debug(
          `[api] Service not available: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    if (!skillPath) {
      error(res, `Skill "${skillId}" not found`, 404);
      return true;
    }

    const { execFile } = await import("node:child_process");
    const opener =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "explorer"
          : "xdg-open";
    execFile(opener, [skillPath], (err) => {
      if (err)
        logger.warn(`[eliza-api] Failed to open skill folder: ${err.message}`);
    });
    json(res, { ok: true, path: skillPath });
    return true;
  }

  // ── GET /api/skills/:id/source ──────────────────────────────────────────
  if (method === "GET" && pathname.match(/^\/api\/skills\/[^/]+\/source$/)) {
    const skillId = decodeAndValidateSkillId(
      pathname.split("/")[3],
      res,
      error,
    );
    if (!skillId) return true;
    const workspaceDir =
      state.config.agents?.defaults?.workspace ??
      resolveDefaultAgentWorkspaceDir();

    const candidates = [
      path.join(workspaceDir, "skills", skillId),
      path.join(workspaceDir, "skills", ".marketplace", skillId),
    ];
    let skillMdPath: string | null = null;
    for (const c of candidates) {
      const md = path.join(c, "SKILL.md");
      if (fs.existsSync(md)) {
        skillMdPath = md;
        break;
      }
    }

    // Try AgentSkillsService for bundled/plugin skills — copy to workspace for editing
    if (!skillMdPath && state.runtime) {
      try {
        const svc = state.runtime.getService("AGENT_SKILLS_SERVICE") as
          | {
              getLoadedSkills?: () => Array<{
                slug: string;
                path: string;
                source: string;
              }>;
            }
          | undefined;
        if (svc?.getLoadedSkills) {
          const loaded = svc.getLoadedSkills().find((s) => s.slug === skillId);
          if (loaded) {
            if (loaded.source === "bundled" || loaded.source === "plugin") {
              const targetDir = path.join(workspaceDir, "skills", skillId);
              if (!fs.existsSync(targetDir)) {
                fs.cpSync(loaded.path, targetDir, { recursive: true });
                state.skills = await discoverSkills(
                  workspaceDir,
                  state.config,
                  state.runtime,
                );
              }
              const md = path.join(targetDir, "SKILL.md");
              if (fs.existsSync(md)) skillMdPath = md;
            } else {
              const md = path.join(loaded.path, "SKILL.md");
              if (fs.existsSync(md)) skillMdPath = md;
            }
          }
        }
      } catch {
        /* ignore */
      }
    }

    if (!skillMdPath) {
      error(res, `Skill "${skillId}" not found`, 404);
      return true;
    }

    try {
      const content = fs.readFileSync(skillMdPath, "utf-8");
      json(res, { ok: true, skillId, content, path: skillMdPath });
    } catch (err) {
      error(
        res,
        `Failed to read skill: ${err instanceof Error ? err.message : "unknown"}`,
        500,
      );
    }
    return true;
  }

  // ── POST /api/skills/:id/enable ─────────────────────────────────────────
  // Canonical verb endpoint for enabling a skill. Honors scan acknowledgment
  // requirements; returns 409 when an unack'd scan blocks enabling.
  if (method === "POST" && pathname.match(/^\/api\/skills\/[^/]+\/enable$/)) {
    const skillId = decodeAndValidateSkillId(
      pathname.split("/")[3],
      res,
      error,
    );
    if (!skillId) return true;

    const skill = state.skills.find((s) => s.id === skillId);
    if (!skill) {
      error(res, `Skill "${skillId}" not found`, 404);
      return true;
    }

    const workspaceDir =
      state.config.agents?.defaults?.workspace ??
      resolveDefaultAgentWorkspaceDir();
    const report = await loadScanReportFromDisk(
      skillId,
      workspaceDir,
      state.runtime,
    );
    if (
      report &&
      (report.status === "critical" || report.status === "warning")
    ) {
      const acks = await loadSkillAcknowledgments(state.runtime);
      const ack = acks[skillId];
      const findings = report.findings as Array<Record<string, unknown>>;
      const manifestFindings = report.manifestFindings as Array<
        Record<string, unknown>
      >;
      const totalFindings = findings.length + manifestFindings.length;
			const reportDigest = skillScanReportDigest(report);
			if (
				!ack ||
				ack.findingCount !== totalFindings ||
				ack.reportDigest !== reportDigest
			) {
        error(
          res,
          `Skill "${skillId}" has ${totalFindings} security finding(s) that must be acknowledged first. Use POST /api/skills/${skillId}/acknowledge.`,
          409,
        );
        return true;
      }
    }

		const enableReportDigest = report
			? skillScanReportDigest(report)
			: undefined;
    if (state.runtime) {
      const svc = state.runtime.getService("AGENT_SKILLS_SERVICE") as
			| {
					acknowledgeSkillScan?: (slug: string, reportDigest: string) => boolean;
					setSkillEnabled?: (
						slug: string,
						enabled: boolean,
						options?: { reportDigest?: string },
					) => boolean;
				}
        | undefined;
		if (enableReportDigest) {
			svc?.acknowledgeSkillScan?.(skillId, enableReportDigest);
		}
		if (
			svc?.setSkillEnabled &&
			!svc.setSkillEnabled(skillId, true, {
				reportDigest: enableReportDigest,
			})
		) {
			error(res, `Skill "${skillId}" could not be enabled.`, 409);
			return true;
		}
			const previousPrefs = await loadSkillPreferences(state.runtime);
			try {
				await state.runtime.setCache(SKILL_PREFS_CACHE_KEY, {
					...previousPrefs,
					[skillId]: true,
				});
			} catch (cause) {
				svc?.setSkillEnabled?.(skillId, false);
				state.runtime.reportError("SkillsRoute.enable", cause, { skillId });
				error(res, `Skill "${skillId}" could not be enabled.`, 500);
				return true;
			}
    }
		skill.enabled = true;
    json(res, {
      ok: true,
      skill,
      scanStatus: skill.scanStatus ?? null,
    });
    return true;
  }

  // ── POST /api/skills/:id/disable ────────────────────────────────────────
  // Canonical verb endpoint for disabling a skill.
  if (method === "POST" && pathname.match(/^\/api\/skills\/[^/]+\/disable$/)) {
    const skillId = decodeAndValidateSkillId(
      pathname.split("/")[3],
      res,
      error,
    );
    if (!skillId) return true;

    const skill = state.skills.find((s) => s.id === skillId);
    if (!skill) {
      error(res, `Skill "${skillId}" not found`, 404);
      return true;
    }

    skill.enabled = false;
    if (state.runtime) {
      const prefs = await loadSkillPreferences(state.runtime);
      prefs[skillId] = false;
      await saveSkillPreferences(state.runtime, prefs);

      const svc = state.runtime.getService("AGENT_SKILLS_SERVICE") as
        | { setSkillEnabled?: (slug: string, enabled: boolean) => boolean }
        | undefined;
      svc?.setSkillEnabled?.(skillId, false);
    }
    json(res, {
      ok: true,
      skill,
      scanStatus: skill.scanStatus ?? null,
    });
    return true;
  }

  // ── PUT /api/skills/:id/source ──────────────────────────────────────────
  if (method === "PUT" && pathname.match(/^\/api\/skills\/[^/]+\/source$/)) {
    const skillId = decodeAndValidateSkillId(
      pathname.split("/")[3],
      res,
      error,
    );
    if (!skillId) return true;
    const rawSource = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawSource === null) return true;
    const parsedSource = PutSkillSourceRequestSchema.safeParse(rawSource);
    if (!parsedSource.success) {
      error(
        res,
        parsedSource.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }

    const workspaceDir =
      state.config.agents?.defaults?.workspace ??
      resolveDefaultAgentWorkspaceDir();

    const candidates = [
      path.join(workspaceDir, "skills", skillId),
      path.join(workspaceDir, "skills", ".marketplace", skillId),
    ];
    let skillMdPath: string | null = null;
    for (const c of candidates) {
      const md = path.join(c, "SKILL.md");
      if (fs.existsSync(md)) {
        skillMdPath = md;
        break;
      }
    }

    // Try AgentSkillsService for bundled/plugin skills — copy to workspace for editing
    if (!skillMdPath && state.runtime) {
      try {
        const svc = state.runtime.getService("AGENT_SKILLS_SERVICE") as
          | {
              getLoadedSkills?: () => Array<{
                slug: string;
                path: string;
                source: string;
              }>;
            }
          | undefined;
        if (svc?.getLoadedSkills) {
          const loaded = svc.getLoadedSkills().find((s) => s.slug === skillId);
          if (loaded) {
            if (loaded.source === "bundled" || loaded.source === "plugin") {
              const targetDir = path.join(workspaceDir, "skills", skillId);
              if (!fs.existsSync(targetDir)) {
                fs.cpSync(loaded.path, targetDir, { recursive: true });
              }
              const md = path.join(targetDir, "SKILL.md");
              if (fs.existsSync(md)) skillMdPath = md;
            } else {
              const md = path.join(loaded.path, "SKILL.md");
              if (fs.existsSync(md)) skillMdPath = md;
            }
          }
        }
      } catch {
        /* ignore */
      }
    }

    if (!skillMdPath) {
      error(res, `Skill "${skillId}" not found`, 404);
      return true;
    }

    try {
      fs.writeFileSync(skillMdPath, parsedSource.data.content, "utf-8");
      // Re-discover skills to pick up unknown name/description changes
      state.skills = await discoverSkills(
        workspaceDir,
        state.config,
        state.runtime,
      );
      const skill = state.skills.find((s) => s.id === skillId);
      json(res, { ok: true, skillId, skill });
    } catch (err) {
      error(
        res,
        `Failed to save skill: ${err instanceof Error ? err.message : "unknown"}`,
        500,
      );
    }
    return true;
  }

  // ── DELETE /api/skills/:id ────────────────────────────────────────────
  if (
    method === "DELETE" &&
    pathname.match(/^\/api\/skills\/[^/]+$/) &&
    !pathname.includes("/marketplace")
  ) {
    const skillId = decodeAndValidateSkillId(
      pathname.slice("/api/skills/".length),
      res,
      error,
    );
    if (!skillId) return true;
    const workspaceDir =
      state.config.agents?.defaults?.workspace ??
      resolveDefaultAgentWorkspaceDir();

    const wsDir = path.join(workspaceDir, "skills", skillId);
    const mpDir = path.join(workspaceDir, "skills", ".marketplace", skillId);
    let deleted = false;
    let source = "";
		let externallyCommitted = false;
		const previousSkills = state.skills;
		let previousPrefs: SkillPreferencesMap | undefined;
		let previousAcks: SkillAcknowledgmentMap | undefined;
		let workspaceRemoval:
			| { rollback(): void; finalize(): void }
			| undefined;
		const requestLifecycle = createInstallRequestLifecycle(req, res);
		try {
			if (fs.existsSync(path.join(wsDir, "SKILL.md"))) {
				requestLifecycle.signal.throwIfAborted();
				workspaceRemoval = prepareWorkspaceSkillRemoval(workspaceDir, skillId);
				deleted = true;
				source = "workspace";
			} else if (fs.existsSync(path.join(mpDir, "SKILL.md"))) {
        const { uninstallMarketplaceSkill: uninstallMp } = await import(
          "../services/skill-marketplace"
        );
				await uninstallMp(workspaceDir, skillId, {
					signal: requestLifecycle.signal,
				});
				await refreshMarketplaceRuntimeSkill(state, skillId);
        deleted = true;
				externallyCommitted = true;
        source = "marketplace";
			} else if (state.runtime) {
        const svc = state.runtime.getService("AGENT_SKILLS_SERVICE") as
					| {
							uninstall?: (
								slug: string,
								options?: { signal?: AbortSignal },
							) => Promise<boolean>;
						}
          | undefined;
        if (svc?.uninstall) {
					deleted = await svc.uninstall(skillId, {
						signal: requestLifecycle.signal,
					});
					if (deleted) {
						externallyCommitted = true;
					}
          source = "catalog";
        }
      }
			if (!externallyCommitted) requestLifecycle.signal.throwIfAborted();

    if (!deleted) {
      error(
        res,
        `Skill "${skillId}" not found or is a bundled skill that cannot be deleted`,
        404,
      );
			requestLifecycle.markCompleted();
      return true;
    }

		if (externallyCommitted) {
			await refreshAfterCommittedSkillMutation(
				state,
				workspaceDir,
				"SkillsRoute.deleteRefresh",
				discoverSkills,
				requestLifecycle.signal,
			);
		} else {
			state.skills = await discoverSkills(
				workspaceDir,
				state.config,
				state.runtime,
			);
			requestLifecycle.signal.throwIfAborted();
		}
		if (state.runtime) {
			try {
				previousPrefs = await loadSkillPreferences(state.runtime);
				previousAcks = await loadSkillAcknowledgments(state.runtime);
				const nextPrefs = { ...previousPrefs };
				const nextAcks = { ...previousAcks };
				delete nextPrefs[skillId];
				delete nextAcks[skillId];
				await Promise.all([
					state.runtime.setCache(SKILL_PREFS_CACHE_KEY, nextPrefs),
					state.runtime.setCache(SKILL_ACK_CACHE_KEY, nextAcks),
				]);
			} catch (cleanupError) {
				if (!externallyCommitted) throw cleanupError;
				state.runtime.reportError("SkillsRoute.deletePreferences", cleanupError, {
					skillId,
				});
			}
		}
		if (externallyCommitted && requestLifecycle.signal.aborted) return true;
		requestLifecycle.signal.throwIfAborted();
		if (workspaceRemoval) {
			const committedRemoval = workspaceRemoval;
			workspaceRemoval = undefined;
			try {
				committedRemoval.finalize();
			} catch (cleanupError) {
				logger.warn(
					`[skills-api] Workspace removal cleanup failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
				);
			}
		}
		requestLifecycle.markCompleted();
		json(res, { ok: true, skillId, source });
    return true;
		} catch (err) {
			const rollbackFailures: unknown[] = [];
			try {
				workspaceRemoval?.rollback();
			} catch (rollbackError) {
				rollbackFailures.push(rollbackError);
			}
			if (workspaceRemoval) {
				state.skills = previousSkills;
				try {
					if (state.runtime && previousPrefs && previousAcks) {
						await Promise.all([
							state.runtime.setCache(SKILL_PREFS_CACHE_KEY, previousPrefs),
							state.runtime.setCache(SKILL_ACK_CACHE_KEY, previousAcks),
						]);
					}
				} catch (rollbackError) {
					rollbackFailures.push(rollbackError);
				}
			}
			if (rollbackFailures.length > 0) {
				state.runtime?.reportError(
					"SkillsRoute.workspaceRemoval",
					new AggregateError([err, ...rollbackFailures]),
					{ skillId },
				);
			}
			if (requestLifecycle.signal.aborted) return true;
			respondToSkillInstallError(ctx, "Failed to uninstall skill", err);
			return true;
		} finally {
			requestLifecycle.dispose();
		}
  }

  // ── GET /api/skills/marketplace/search ─────────────────────────────────
  if (method === "GET" && pathname === "/api/skills/marketplace/search") {
    const query = url.searchParams.get("q") ?? "";
    if (!query.trim()) {
      error(res, "Query parameter 'q' is required", 400);
      return true;
    }
    try {
      const limitStr = url.searchParams.get("limit");
      const limit = limitStr
        ? parseClampedInteger(limitStr, { min: 1, max: 50, fallback: 20 })
        : 20;
      const results = (await searchSkillsMarketplace(query, { limit })).filter(
        (skill) => shouldExposeBinanceSkillRecord(skill),
      );
      json(res, { ok: true, results });
    } catch (err) {
      logger.warn(
        `[skills-marketplace] Marketplace search failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      error(res, "Skills marketplace search failed", 502);
    }
    return true;
  }

  // ── GET /api/skills/marketplace/installed ─────────────────────────────
  if (method === "GET" && pathname === "/api/skills/marketplace/installed") {
    try {
      const workspaceDir =
        state.config.agents?.defaults?.workspace ??
        resolveDefaultAgentWorkspaceDir();
      const installed = await listInstalledMarketplaceSkills(workspaceDir);
      json(res, { ok: true, skills: installed.map(publicMarketplaceSkill) });
    } catch (err) {
      logger.warn(
        `[skills-marketplace] Installed-skill listing failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      error(res, "Failed to list installed skills", 500);
    }
    return true;
  }

  // ── POST /api/skills/marketplace/install ──────────────────────────────
  if (method === "POST" && pathname === "/api/skills/marketplace/install") {
    const rawMpInstall = await readJsonBody<Record<string, unknown>>(req, res);
    if (rawMpInstall === null) return true;
    const parsedMpInstall =
      PostMarketplaceInstallRequestSchema.safeParse(rawMpInstall);
    if (!parsedMpInstall.success) {
      error(
        res,
        parsedMpInstall.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    const body = parsedMpInstall.data;

    const slug = body.slug ?? "";
    const githubUrl = body.githubUrl ?? "";
    const repository = body.repository ?? "";

    try {
      const workspaceDir =
        state.config.agents?.defaults?.workspace ??
        resolveDefaultAgentWorkspaceDir();

      // ClawHub-native install path (slug-based via AgentSkillsService).
      if (slug && !githubUrl && !repository) {
        if (!state.runtime) {
          error(
            res,
            "Agent runtime not available — start the agent first",
            503,
          );
          return true;
        }

        const service = state.runtime.getService("AGENT_SKILLS_SERVICE") as
          | {
              install?: (
                skillSlug: string,
                opts?: {
                  version?: string;
                  force?: boolean;
                  signal?: AbortSignal;
                  throwOnDownloadError?: boolean;
                },
              ) => Promise<boolean>;
              isInstalled?: (skillSlug: string) => Promise<boolean>;
            }
          | undefined;

        if (!service || typeof service.install !== "function") {
          error(
            res,
            "AgentSkillsService not available — ensure @elizaos/plugin-agent-skills is loaded",
            501,
          );
          return true;
        }

        const requestLifecycle = createInstallRequestLifecycle(req, res);
        try {
          const alreadyInstalled =
            typeof service.isInstalled === "function"
              ? await service.isInstalled(slug)
              : false;
          requestLifecycle.signal.throwIfAborted();

          if (alreadyInstalled) {
            json(res, {
              ok: true,
              skill: {
                id: slug,
                name: body.name ?? slug,
                source: "clawhub",
                installedAt: new Date().toISOString(),
              },
              alreadyInstalled: true,
            });
            requestLifecycle.markCompleted();
            return true;
          }

          const success = await service.install(slug, {
            signal: requestLifecycle.signal,
            throwOnDownloadError: true,
          });
          if (!success) {
            error(res, `Failed to install skill "${slug}"`, 500);
            requestLifecycle.markCompleted();
            return true;
          }

					await refreshAfterCommittedSkillMutation(
						state,
						workspaceDir,
						"SkillsRoute.marketplaceCatalogInstallRefresh",
						discoverSkills,
						requestLifecycle.signal,
					);
					requestLifecycle.signal.throwIfAborted();

          json(res, {
            ok: true,
            skill: {
              id: slug,
              name: body.name?.trim() || slug,
              source: "clawhub",
              installedAt: new Date().toISOString(),
            },
          });
          requestLifecycle.markCompleted();
        } catch (cause) {
          // error-policy:J1 a disconnected HTTP request owns cancellation and
          // must not receive a late response from the completed install path.
          if (requestLifecycle.signal.aborted) return true;
          throw cause;
        } finally {
          requestLifecycle.dispose();
        }
      } else {
        const requestLifecycle = createInstallRequestLifecycle(req, res);
        try {
          const result = await installMarketplaceSkill(
            workspaceDir,
            {
              githubUrl: body.githubUrl,
              repository: body.repository,
              path: body.path,
              name: body.name,
              description: body.description,
              source: body.source === "manual" ? "manual" : "clawhub",
            },
            { signal: requestLifecycle.signal },
          );
					await refreshMarketplaceRuntimeSkill(state, result.id);
					await refreshAfterCommittedSkillMutation(
						state,
						workspaceDir,
						"SkillsRoute.marketplaceInstallRefresh",
						discoverSkills,
						requestLifecycle.signal,
					);
					requestLifecycle.signal.throwIfAborted();
          json(res, { ok: true, skill: publicMarketplaceSkill(result) });
          requestLifecycle.markCompleted();
        } catch (cause) {
          // error-policy:J1 A disconnected repository install owns its git,
          // copy, scan, and publication cancellation and receives no late write.
          if (requestLifecycle.signal.aborted) return true;
          throw cause;
        } finally {
          requestLifecycle.dispose();
        }
      }
    } catch (err) {
      respondToSkillInstallError(ctx, "Install failed", err);
    }
    return true;
  }

  // ── POST /api/skills/marketplace/uninstall ────────────────────────────
  if (method === "POST" && pathname === "/api/skills/marketplace/uninstall") {
    const rawMpUninstall = await readJsonBody<Record<string, unknown>>(
      req,
      res,
    );
    if (rawMpUninstall === null) return true;
    const parsedMpUninstall =
      PostMarketplaceUninstallRequestSchema.safeParse(rawMpUninstall);
    if (!parsedMpUninstall.success) {
      error(
        res,
        parsedMpUninstall.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }

    const uninstallId = validateSkillId(parsedMpUninstall.data.id, res, error);
    if (!uninstallId) return true;

    const requestLifecycle = createInstallRequestLifecycle(req, res);
    try {
      const workspaceDir =
        state.config.agents?.defaults?.workspace ??
        resolveDefaultAgentWorkspaceDir();
      const result = await uninstallMarketplaceSkill(workspaceDir, uninstallId, {
        signal: requestLifecycle.signal,
      });
		await refreshMarketplaceRuntimeSkill(state, uninstallId);

			await refreshAfterCommittedSkillMutation(
				state,
				workspaceDir,
				"SkillsRoute.marketplaceUninstallRefresh",
				discoverSkills,
				requestLifecycle.signal,
			);
			requestLifecycle.signal.throwIfAborted();

      json(res, { ok: true, skill: publicMarketplaceSkill(result) });
			requestLifecycle.markCompleted();
    } catch (err) {
      if (requestLifecycle.signal.aborted) return true;
      respondToSkillInstallError(ctx, "Uninstall failed", err);
    } finally {
      requestLifecycle.dispose();
    }
    return true;
  }

  return false;
}
