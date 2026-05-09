import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import { logger } from "@elizaos/core";
import {
  parseClampedInteger,
  resolveDefaultAgentWorkspaceDir,
} from "@elizaos/agent";
import type { ReadJsonBodyOptions } from "@elizaos/core";
import type { ElizaConfig } from "@elizaos/shared";

/**
 * Markdown scaffold for new skill SKILL.md files.
 * Placeholders __SLUG__ and __DESCRIPTION__ are replaced at scaffold time.
 */
const skillScaffoldMarkdown = `---
name: __SLUG__
description: __DESCRIPTION__
---

## Instructions

[Describe what this skill does and how the agent should use it]

## When to Use

Use this skill when [describe trigger conditions].

## Steps

1. [First step]
2. [Second step]
3. [Third step]
`;
import {
  installMarketplaceSkill,
  listInstalledMarketplaceSkills,
  searchSkillsMarketplace,
  uninstallMarketplaceSkill,
} from "../services/skill-marketplace.js";

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
  // Functions from server.ts that skills routes need
  discoverSkills: (
    workspaceDir: string,
    config: ElizaConfig,
    runtime: AgentRuntime | null,
  ) => Promise<SkillEntry[]>;
  saveElizaConfig: (config: ElizaConfig) => void;
}

export interface SkillsServerState {
  runtime: AgentRuntime | null;
  config: ElizaConfig;
  skills: SkillEntry[];
}

// ---------------------------------------------------------------------------
// Skill ID validation
// ---------------------------------------------------------------------------

const SAFE_SKILL_ID_RE = /^[a-zA-Z0-9._-]+$/;

function validateSkillId(
  skillId: string,
  res: http.ServerResponse,
  errorFn: SkillsRouteContext["error"],
): string | null {
  if (
    !skillId ||
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

async function loadSkillPreferences(
  runtime: AgentRuntime | null,
): Promise<SkillPreferencesMap> {
  if (!runtime) return {};
  try {
    const prefs = await runtime.getCache<SkillPreferencesMap>(
      SKILL_PREFS_CACHE_KEY,
    );
    return prefs ?? {};
  } catch {
    return {};
  }
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
  { acknowledgedAt: string; findingCount: number }
>;

async function loadSkillAcknowledgments(
  runtime: AgentRuntime | null,
): Promise<SkillAcknowledgmentMap> {
  if (!runtime) return {};
  try {
    const acks =
      await runtime.getCache<SkillAcknowledgmentMap>(SKILL_ACK_CACHE_KEY);
    return acks ?? {};
  } catch {
    return {};
  }
}

async function saveSkillAcknowledgments(
  runtime: AgentRuntime,
  acks: SkillAcknowledgmentMap,
): Promise<void> {
  try {
    await runtime.setCache(SKILL_ACK_CACHE_KEY, acks);
  } catch (err) {
    logger.debug(
      `[eliza-api] Failed to save skill acknowledgments: ${err instanceof Error ? err.message : err}`,
    );
  }
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
    readBody,
    discoverSkills,
    saveElizaConfig,
  } = ctx;

  // ── GET /api/skills/catalog ───────────────────────────────────────────
  // Browse the full skill catalog (paginated).
  if (method === "GET" && pathname === "/api/skills/catalog") {
    try {
      const { getCatalogSkills } = await import(
        "../services/skill-catalog-client.js"
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
          (a.displayName ?? a.slug).localeCompare(b.displayName ?? b.slug),
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
        "../services/skill-catalog-client.js"
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
    const slug = decodeURIComponent(
      pathname.slice("/api/skills/catalog/".length),
    );
    // Exclude "search" which is handled above
    if (slug && slug !== "search") {
      if (!shouldExposeBinanceSkillId(slug)) {
        error(res, `Skill "${slug}" not found in catalog`, 404);
        return true;
      }
      try {
        const { getCatalogSkill } = await import(
          "../services/skill-catalog-client.js"
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
        "../services/skill-catalog-client.js"
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
    const body = await readJsonBody<{ slug: string; version?: string }>(
      req,
      res,
    );
    if (!body) return true;
    if (!body.slug) {
      error(res, "Missing required field: slug", 400);
      return true;
    }

    if (!state.runtime) {
      error(res, "Agent runtime not available — start the agent first", 503);
      return true;
    }

    try {
      const service = state.runtime.getService("AGENT_SKILLS_SERVICE") as
        | {
            install?: (
              slug: string,
              opts?: { version?: string; force?: boolean },
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

      const alreadyInstalled =
        typeof service.isInstalled === "function"
          ? await service.isInstalled(body.slug)
          : false;

      if (alreadyInstalled) {
        json(res, {
          ok: true,
          slug: body.slug,
          message: `Skill "${body.slug}" is already installed`,
          alreadyInstalled: true,
        });
        return true;
      }

      const success = await service.install(body.slug, {
        version: body.version,
      });

      if (success) {
        // Refresh the skills list so the UI picks up the new skill
        const workspaceDir =
          state.config.agents?.defaults?.workspace ??
          resolveDefaultAgentWorkspaceDir();
        state.skills = await discoverSkills(
          workspaceDir,
          state.config,
          state.runtime,
        );

        json(res, {
          ok: true,
          slug: body.slug,
          message: `Skill "${body.slug}" installed successfully`,
        });
      } else {
        error(res, `Failed to install skill "${body.slug}"`, 500);
      }
    } catch (err) {
      error(
        res,
        `Skill install failed: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
    }
    return true;
  }

  // ── POST /api/skills/catalog/uninstall ─────────────────────────────────
  if (method === "POST" && pathname === "/api/skills/catalog/uninstall") {
    const body = await readJsonBody<{ slug: string }>(req, res);
    if (!body) return true;
    if (!body.slug) {
      error(res, "Missing required field: slug", 400);
      return true;
    }

    if (!state.runtime) {
      error(res, "Agent runtime not available — start the agent first", 503);
      return true;
    }

    try {
      const service = state.runtime.getService("AGENT_SKILLS_SERVICE") as
        | {
            uninstall?: (slug: string) => Promise<boolean>;
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

      const success = await service.uninstall(body.slug);

      if (success) {
        // Refresh the skills list
        const workspaceDir =
          state.config.agents?.defaults?.workspace ??
          resolveDefaultAgentWorkspaceDir();
        state.skills = await discoverSkills(
          workspaceDir,
          state.config,
          state.runtime,
        );

        json(res, {
          ok: true,
          slug: body.slug,
          message: `Skill "${body.slug}" uninstalled successfully`,
        });
      } else {
        error(
          res,
          `Failed to uninstall skill "${body.slug}" — it may be a bundled skill`,
          400,
        );
      }
    } catch (err) {
      error(
        res,
        `Skill uninstall failed: ${err instanceof Error ? err.message : String(err)}`,
        500,
      );
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
    const skillId = validateSkillId(
      decodeURIComponent(pathname.split("/")[3]),
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
    json(res, { ok: true, report, acknowledged: !!ack, acknowledgment: ack });
    return true;
  }

  // ── POST /api/skills/:id/acknowledge ──────────────────────────────────
  if (
    method === "POST" &&
    pathname.match(/^\/api\/skills\/[^/]+\/acknowledge$/)
  ) {
    const skillId = validateSkillId(
      decodeURIComponent(pathname.split("/")[3]),
      res,
      error,
    );
    if (!skillId) return true;
    const body = await readJsonBody<{ enable?: boolean }>(req, res);
    if (!body) return true;

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

    if (state.runtime) {
      const acks = await loadSkillAcknowledgments(state.runtime);
      acks[skillId] = {
        acknowledgedAt: new Date().toISOString(),
        findingCount: totalFindings,
      };
      await saveSkillAcknowledgments(state.runtime, acks);
    }

    if (body.enable === true) {
      const skill = state.skills.find((s) => s.id === skillId);
      if (skill) {
        skill.enabled = true;
        if (state.runtime) {
          const prefs = await loadSkillPreferences(state.runtime);
          prefs[skillId] = true;
          await saveSkillPreferences(state.runtime, prefs);
        }
      }
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
    const body = await readJsonBody<{ name: string; description?: string }>(
      req,
      res,
    );
    if (!body) return true;
    const rawName = body.name?.trim();
    if (!rawName) {
      error(res, "Skill name is required", 400);
      return true;
    }

    const slug = rawName
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

    const workspaceDir =
      state.config.agents?.defaults?.workspace ??
      resolveDefaultAgentWorkspaceDir();
    const skillDir = path.join(workspaceDir, "skills", slug);

    if (fs.existsSync(skillDir)) {
      error(res, `Skill "${slug}" already exists`, 409);
      return true;
    }

    const description =
      body.description?.trim() || "Describe what this skill does.";
    const escapedDescription = description
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"');
    const template = skillScaffoldMarkdown
      .replace(/__SLUG__/g, slug)
      .replace(/__DESCRIPTION__/g, escapedDescription);

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
      skill: skill ?? { id: slug, name: slug, description, enabled: true },
      path: skillDir,
    });
    return true;
  }

  // ── POST /api/skills/:id/open ─────────────────────────────────────────
  if (method === "POST" && pathname.match(/^\/api\/skills\/[^/]+\/open$/)) {
    const skillId = validateSkillId(
      decodeURIComponent(pathname.split("/")[3]),
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
    const skillId = validateSkillId(
      decodeURIComponent(pathname.split("/")[3]),
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
    const skillId = validateSkillId(
      decodeURIComponent(pathname.split("/")[3]),
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
      if (!ack || ack.findingCount !== totalFindings) {
        error(
          res,
          `Skill "${skillId}" has ${totalFindings} security finding(s) that must be acknowledged first. Use POST /api/skills/${skillId}/acknowledge.`,
          409,
        );
        return true;
      }
    }

    skill.enabled = true;
    if (state.runtime) {
      const prefs = await loadSkillPreferences(state.runtime);
      prefs[skillId] = true;
      await saveSkillPreferences(state.runtime, prefs);

      const svc = state.runtime.getService("AGENT_SKILLS_SERVICE") as
        | { setSkillEnabled?: (slug: string, enabled: boolean) => boolean }
        | undefined;
      svc?.setSkillEnabled?.(skillId, true);
    }
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
    const skillId = validateSkillId(
      decodeURIComponent(pathname.split("/")[3]),
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
    const skillId = validateSkillId(
      decodeURIComponent(pathname.split("/")[3]),
      res,
      error,
    );
    if (!skillId) return true;
    const body = await readBody(req);
    if (!body) return true;

    let parsed: { content?: string };
    try {
      parsed = JSON.parse(body);
    } catch {
      error(res, "Invalid JSON body", 400);
      return true;
    }
    if (typeof parsed.content !== "string") {
      error(res, "Missing 'content' field", 400);
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
      fs.writeFileSync(skillMdPath, parsed.content, "utf-8");
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
    const skillId = validateSkillId(
      decodeURIComponent(pathname.slice("/api/skills/".length)),
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

    if (fs.existsSync(path.join(wsDir, "SKILL.md"))) {
      fs.rmSync(wsDir, { recursive: true, force: true });
      deleted = true;
      source = "workspace";
    } else if (fs.existsSync(path.join(mpDir, "SKILL.md"))) {
      try {
        const { uninstallMarketplaceSkill: uninstallMp } = await import(
          "../services/skill-marketplace.js"
        );
        await uninstallMp(workspaceDir, skillId);
        deleted = true;
        source = "marketplace";
      } catch (err) {
        error(
          res,
          `Failed to uninstall: ${err instanceof Error ? err.message : String(err)}`,
          500,
        );
        return true;
      }
    } else if (state.runtime) {
      try {
        const svc = state.runtime.getService("AGENT_SKILLS_SERVICE") as
          | { uninstall?: (slug: string) => Promise<boolean> }
          | undefined;
        if (svc?.uninstall) {
          deleted = await svc.uninstall(skillId);
          source = "catalog";
        }
      } catch (err) {
        logger.debug(
          `[api] Service not available: ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    if (!deleted) {
      error(
        res,
        `Skill "${skillId}" not found or is a bundled skill that cannot be deleted`,
        404,
      );
      return true;
    }

    state.skills = await discoverSkills(
      workspaceDir,
      state.config,
      state.runtime,
    );
    if (state.runtime) {
      const prefs = await loadSkillPreferences(state.runtime);
      delete prefs[skillId];
      await saveSkillPreferences(state.runtime, prefs);
      const acks = await loadSkillAcknowledgments(state.runtime);
      delete acks[skillId];
      await saveSkillAcknowledgments(state.runtime, acks);
    }
    json(res, { ok: true, skillId, source });
    return true;
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
      const msg = err instanceof Error ? err.message : String(err);
      error(res, msg, 502);
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
      json(res, { ok: true, skills: installed });
    } catch (err) {
      error(
        res,
        `Failed to list installed skills: ${err instanceof Error ? err.message : err}`,
        500,
      );
    }
    return true;
  }

  // ── POST /api/skills/marketplace/install ──────────────────────────────
  if (method === "POST" && pathname === "/api/skills/marketplace/install") {
    const body = await readJsonBody<{
      slug?: string;
      githubUrl?: string;
      repository?: string;
      path?: string;
      name?: string;
      description?: string;
      source?: "clawhub" | "skillsmp" | "manual";
    }>(req, res);
    if (!body) return true;

    const slug = body.slug?.trim() || "";
    const githubUrl = body.githubUrl?.trim() || "";
    const repository = body.repository?.trim() || "";

    if (!slug && !githubUrl && !repository) {
      error(res, "Install requires a slug, githubUrl, or repository", 400);
      return true;
    }

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
                opts?: { version?: string; force?: boolean },
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

        const alreadyInstalled =
          typeof service.isInstalled === "function"
            ? await service.isInstalled(slug)
            : false;

        if (alreadyInstalled) {
          json(res, {
            ok: true,
            skill: {
              id: slug,
              name: body.name?.trim() || slug,
              source: "clawhub",
              installedAt: new Date().toISOString(),
            },
            alreadyInstalled: true,
          });
          return true;
        }

        const success = await service.install(slug);
        if (!success) {
          error(res, `Failed to install skill "${slug}"`, 500);
          return true;
        }

        state.skills = await discoverSkills(
          workspaceDir,
          state.config,
          state.runtime,
        );

        json(res, {
          ok: true,
          skill: {
            id: slug,
            name: body.name?.trim() || slug,
            source: "clawhub",
            installedAt: new Date().toISOString(),
          },
        });
      } else {
        const result = await installMarketplaceSkill(workspaceDir, {
          githubUrl: body.githubUrl,
          repository: body.repository,
          path: body.path,
          name: body.name,
          description: body.description,
          source:
            body.source === "manual" || body.source === "skillsmp"
              ? body.source
              : "clawhub",
        });

        state.skills = await discoverSkills(
          workspaceDir,
          state.config,
          state.runtime,
        );

        json(res, { ok: true, skill: result });
      }
    } catch (err) {
      error(
        res,
        `Install failed: ${err instanceof Error ? err.message : err}`,
        500,
      );
    }
    return true;
  }

  // ── POST /api/skills/marketplace/uninstall ────────────────────────────
  if (method === "POST" && pathname === "/api/skills/marketplace/uninstall") {
    const body = await readJsonBody<{ id?: string }>(req, res);
    if (!body) return true;

    if (!body.id?.trim()) {
      error(res, "Request body must include 'id' (skill id to uninstall)", 400);
      return true;
    }

    const uninstallId = validateSkillId(body.id.trim(), res, error);
    if (!uninstallId) return true;

    try {
      const workspaceDir =
        state.config.agents?.defaults?.workspace ??
        resolveDefaultAgentWorkspaceDir();
      const result = await uninstallMarketplaceSkill(workspaceDir, uninstallId);

      state.skills = await discoverSkills(
        workspaceDir,
        state.config,
        state.runtime,
      );

      json(res, { ok: true, skill: result });
    } catch (err) {
      error(
        res,
        `Uninstall failed: ${err instanceof Error ? err.message : err}`,
        500,
      );
    }
    return true;
  }

  // ── GET /api/skills/marketplace/config ──────────────────────────────────
  if (method === "GET" && pathname === "/api/skills/marketplace/config") {
    json(res, { keySet: Boolean(process.env.SKILLSMP_API_KEY?.trim()) });
    return true;
  }

  // ── PUT /api/skills/marketplace/config ─────────────────────────────────
  if (method === "PUT" && pathname === "/api/skills/marketplace/config") {
    const body = await readJsonBody<{ apiKey?: string }>(req, res);
    if (!body) return true;
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    if (!apiKey) {
      error(res, "Request body must include 'apiKey'", 400);
      return true;
    }
    process.env.SKILLSMP_API_KEY = apiKey;
    if (!state.config.env) state.config.env = {};
    (state.config.env as Record<string, string>).SKILLSMP_API_KEY = apiKey;
    saveElizaConfig(state.config);
    json(res, { ok: true, keySet: true });
    return true;
  }

  return false;
}
