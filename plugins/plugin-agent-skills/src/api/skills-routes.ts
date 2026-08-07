/**
 * HTTP route handlers for the skill-management surface mounted under
 * /api/skills/*: workspace skill CRUD, direct GitHub installation,
 * security-scan acknowledgement, and enable/disable persistence. The agent's
 * HTTP server dispatches to these via `handleSkillsRoutes`.
 *
 * Enable/disable state persists in the agent database under a cache key;
 * workspace discovery resolves the agent workspace dir from ELIZA_WORKSPACE_DIR,
 * persisted folder config, cwd project markers, then the state dir.
 */

import fs from "node:fs";
import type http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AgentRuntime } from "@elizaos/core";
import { logger, readWorkspaceFolderConfig } from "@elizaos/core";
import type { ReadJsonBodyOptions } from "@elizaos/shared";
import {
  PostSkillAcknowledgeRequestSchema,
  PostSkillCreateRequestSchema,
  PostSkillInstallRequestSchema,
  PutSkillSourceRequestSchema,
  readAliasedEnv,
} from "@elizaos/shared";
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
  { acknowledgedAt: string; findingCount: number }
>;

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
    state,
    json,
    error,
    readJsonBody,
    discoverSkills,
  } = ctx;

  // ── POST /api/skills/install ──────────────────────────────────────────
  if (method === "POST" && pathname === "/api/skills/install") {
    const raw = await readJsonBody<Record<string, unknown>>(req, res);
    if (raw === null) return true;
    const parsed = PostSkillInstallRequestSchema.safeParse(raw);
    if (!parsed.success) {
      error(
        res,
        parsed.error.issues[0]?.message ?? "Invalid request body",
        400,
      );
      return true;
    }
    if (!state.runtime) {
      error(res, "Agent runtime not available — start the agent first", 503);
      return true;
    }

    try {
      const service = state.runtime.getService("AGENT_SKILLS_SERVICE") as
        | {
            installFromGitHub?: (githubUrl: string) => Promise<boolean>;
          }
        | undefined;

      if (!service || typeof service.installFromGitHub !== "function") {
        error(
          res,
          "AgentSkillsService not available — ensure @elizaos/plugin-agent-skills is loaded",
          501,
        );
        return true;
      }

      const success = await service.installFromGitHub(parsed.data.githubUrl);

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
          message: "Skill installed from GitHub",
        });
      } else {
        error(res, "Failed to install skill from GitHub", 500);
      }
    } catch (err) {
      // error-policy:J1 The HTTP boundary returns an explicit install failure.
      error(
        res,
        `Skill install failed: ${err instanceof Error ? err.message : String(err)}`,
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

    const workspaceDir =
      state.config.agents?.defaults?.workspace ??
      resolveDefaultAgentWorkspaceDir();
    const skillDir = path.join(workspaceDir, "skills", slug);

    if (fs.existsSync(skillDir)) {
      error(res, `Skill "${slug}" already exists`, 409);
      return true;
    }

    const description = body.description ?? "Describe what this skill does.";
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

    const candidates = [path.join(workspaceDir, "skills", skillId)];
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

    const candidates = [path.join(workspaceDir, "skills", skillId)];
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

    const candidates = [path.join(workspaceDir, "skills", skillId)];
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
  if (method === "DELETE" && pathname.match(/^\/api\/skills\/[^/]+$/)) {
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
    let deleted = false;
    let source = "";

    if (fs.existsSync(path.join(wsDir, "SKILL.md"))) {
      fs.rmSync(wsDir, { recursive: true, force: true });
      deleted = true;
      source = "workspace";
    } else if (state.runtime) {
      try {
        const svc = state.runtime.getService("AGENT_SKILLS_SERVICE") as
          | { uninstall?: (slug: string) => Promise<boolean> }
          | undefined;
        if (svc?.uninstall) {
          deleted = await svc.uninstall(skillId);
          source = "managed";
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

  return false;
}
