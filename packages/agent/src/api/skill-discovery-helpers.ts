/**
 * Skill discovery and preference persistence helpers.
 *
 * Extracted from server.ts. Handles loading/saving skill preferences,
 * discovering skills from filesystem and AgentSkillsService, and
 * Binance skill exposure filtering.
 */

import fs from "node:fs";
import path from "node:path";
import { type AgentRuntime, logger } from "@elizaos/core";
import type { ElizaConfig } from "../config/config.js";
import { resolveStateDir } from "../config/paths.js";
import type { SkillEntry } from "./skills-routes.js";

/** Cache key for persisting skill enable/disable state in the agent database. */
const SKILL_PREFS_CACHE_KEY = "eliza:skill-preferences";

/** Shape stored in the cache: maps skill ID → enabled flag. */
type SkillPreferencesMap = Record<string, boolean>;

interface AgentSkillsServiceLike {
  getLoadedSkills?: () => Array<{
    slug: string;
    name: string;
    description: string;
    source: string;
    path: string;
  }>;
  getSkillScanStatus?: (
    slug: string,
  ) => "clean" | "warning" | "critical" | "blocked" | null;
}

function isAgentSkillsServiceLike(
  service: unknown,
): service is AgentSkillsServiceLike {
  return typeof service === "object" && service !== null;
}

/**
 * Load persisted skill preferences from the agent's database.
 * Returns an empty map when the runtime or database isn't available.
 */
export async function loadSkillPreferences(
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

/**
 * Persist skill preferences to the agent's database.
 */
export async function saveSkillPreferences(
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
// Skill scan acknowledgments — tracks user review of security findings
// ---------------------------------------------------------------------------

const SKILL_ACK_CACHE_KEY = "eliza:skill-scan-acknowledgments";

type SkillAcknowledgmentMap = Record<
  string,
  { acknowledgedAt: string; findingCount: number }
>;

export async function loadSkillAcknowledgments(
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

export async function saveSkillAcknowledgments(
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

/**
 * Load a .scan-results.json from the skill's directory on disk.
 *
 * Checks multiple locations because skills can be installed from different sources:
 * - Workspace skills: {workspace}/skills/{id}/
 * - Marketplace skills: {workspace}/skills/.marketplace/{id}/
 * - Catalog-installed (managed) skills: {managed-dir}/{id}/ (default: ./skills/)
 *
 * Also queries the AgentSkillsService for the skill's path when a runtime is available,
 * which covers all sources regardless of directory layout.
 */
export async function loadScanReportFromDisk(
  skillId: string,
  workspaceDir: string,
  runtime?: AgentRuntime | null,
): Promise<Record<string, unknown> | null> {
  const fsSync = await import("node:fs");
  const pathMod = await import("node:path");

  const candidates = [
    pathMod.join(workspaceDir, "skills", skillId, ".scan-results.json"),
    pathMod.join(
      workspaceDir,
      "skills",
      ".marketplace",
      skillId,
      ".scan-results.json",
    ),
  ];

  // Also check the path reported by the AgentSkillsService (covers catalog-installed skills
  // whose managed dir might differ from the workspace dir)
  if (runtime) {
    const svc = runtime.getService("AGENT_SKILLS_SERVICE") as
      | { getLoadedSkills?: () => Array<{ slug: string; path: string }> }
      | undefined;
    if (svc?.getLoadedSkills) {
      const loaded = svc.getLoadedSkills().find((s) => s.slug === skillId);
      if (loaded?.path) {
        candidates.push(pathMod.join(loaded.path, ".scan-results.json"));
      }
    }
  }

  // Deduplicate in case paths overlap
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const resolved = pathMod.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);

    if (!fsSync.existsSync(resolved)) continue;
    const content = fsSync.readFileSync(resolved, "utf-8");
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

/**
 * Determine whether a skill should be enabled.
 *
 * Priority (highest first):
 *   1. Database preferences (per-agent, persisted via PUT /api/skills/:id)
 *   2. `skills.denyBundled` config — always blocks
 *   3. `skills.entries[id].enabled` config — per-skill default
 *   4. `skills.allowBundled` config — whitelist mode
 *   5. Default: enabled
 */
export function resolveSkillEnabled(
  id: string,
  config: ElizaConfig,
  dbPrefs: SkillPreferencesMap,
): boolean {
  // Database preference takes priority (explicit user action)
  if (id in dbPrefs) return dbPrefs[id];

  const skillsCfg = config.skills;

  // Deny list always blocks
  if (skillsCfg?.denyBundled?.includes(id)) return false;

  // Per-skill config entry
  const entry = skillsCfg?.entries?.[id];
  if (entry && entry.enabled === false) return false;
  if (entry && entry.enabled === true) return true;

  // Allowlist: if set, only listed skills are enabled
  if (skillsCfg?.allowBundled && skillsCfg.allowBundled.length > 0) {
    return skillsCfg.allowBundled.includes(id);
  }

  return true;
}

export function parseSkillDirsSetting(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((dir) => dir.trim())
    .filter((dir) => dir.length > 0);
}

const EXPOSED_BINANCE_SKILL_IDS = new Set([
  "binance-crypto-market-rank",
  "binance-meme-rush",
  "binance-query-address-info",
  "binance-query-token-audit",
  "binance-query-token-info",
  "binance-trading-signal",
]);

export function shouldExposeBinanceSkillId(skillId: string): boolean {
  const normalized = skillId.trim();
  if (!normalized.startsWith("binance-")) return true;
  return EXPOSED_BINANCE_SKILL_IDS.has(normalized);
}

export function shouldExposeBinanceSkillRecord(skill: {
  id?: unknown;
  slug?: unknown;
}): boolean {
  const slug = typeof skill.slug === "string" ? skill.slug.trim() : "";
  if (slug) return shouldExposeBinanceSkillId(slug);
  const id = typeof skill.id === "string" ? skill.id.trim() : "";
  if (id) return shouldExposeBinanceSkillId(id);
  return true;
}

/**
 * Discover skills from @elizaos/skills and workspace, applying
 * database preferences and config filtering.
 *
 * When a runtime is available, skills are primarily sourced from the
 * AgentSkillsService (which has already loaded, validated, and
 * precedence-resolved all skills). Filesystem scanning is used as a
 * fallback when the service isn't registered.
 */
export async function discoverSkills(
  workspaceDir: string,
  config: ElizaConfig,
  runtime: AgentRuntime | null,
): Promise<SkillEntry[]> {
  // Load persisted preferences from the agent database
  const dbPrefs = await loadSkillPreferences(runtime);

  // ── Primary path: pull from AgentSkillsService (most accurate) ──────────
  if (runtime) {
    try {
      const service = runtime.getService("AGENT_SKILLS_SERVICE");
      const svc = isAgentSkillsServiceLike(service) ? service : undefined;
      if (svc && typeof svc.getLoadedSkills === "function") {
        const loadedSkills = svc.getLoadedSkills();

        if (loadedSkills.length > 0) {
          const skills: SkillEntry[] = loadedSkills
            .filter((s) => shouldExposeBinanceSkillId(s.slug))
            .map((s) => {
              // Get scan status from in-memory map (fast) or from disk report
              let scanStatus: SkillEntry["scanStatus"] = null;
              if (svc.getSkillScanStatus) {
                scanStatus = svc.getSkillScanStatus(s.slug);
              }
              if (!scanStatus) {
                // Check for .scan-results.json on disk
                const reportPath = path.join(s.path, ".scan-results.json");
                if (fs.existsSync(reportPath)) {
                  const raw = fs.readFileSync(reportPath, "utf-8");
                  try {
                    const parsed = JSON.parse(raw) as { status?: string };
                    if (parsed.status) {
                      scanStatus = parsed.status as
                        | "clean"
                        | "warning"
                        | "critical"
                        | "blocked";
                    }
                  } catch {
                    // Malformed scan report — treat as unscanned.
                  }
                }
              }

              return {
                id: s.slug,
                name: s.name || s.slug,
                description: (s.description || "").slice(0, 200),
                enabled: resolveSkillEnabled(s.slug, config, dbPrefs),
                scanStatus,
              };
            });

          return skills.sort((a, b) => a.name.localeCompare(b.name));
        }
      }
    } catch {
      logger.debug(
        "[eliza-api] AgentSkillsService not available, falling back to filesystem scan",
      );
    }
  }

  // ── Fallback: filesystem scanning ───────────────────────────────────────
  const skillsDirs = new Set<string>();

  // Bundled skills from the @elizaos/skills package
  try {
    const skillsPkg = (await import(/* @vite-ignore */ "@elizaos/skills")) as {
      getSkillsDir: () => string;
    };
    const bundledDir = skillsPkg.getSkillsDir();
    if (bundledDir && fs.existsSync(bundledDir)) {
      skillsDirs.add(bundledDir);
    }
  } catch {
    logger.debug(
      "[eliza-api] @elizaos/skills not available for skill discovery",
    );
  }

  // Runtime-provided skill directories (works even when @elizaos/skills is not installed
  // as a direct dependency and AgentSkillsService catalog sync is degraded).
  if (runtime && typeof runtime.getSetting === "function") {
    for (const dir of parseSkillDirsSetting(
      runtime.getSetting("BUNDLED_SKILLS_DIRS"),
    )) {
      if (fs.existsSync(dir)) skillsDirs.add(dir);
    }
    for (const dir of parseSkillDirsSetting(
      runtime.getSetting("EXTRA_SKILLS_DIRS"),
    )) {
      if (fs.existsSync(dir)) skillsDirs.add(dir);
    }
    for (const dir of parseSkillDirsSetting(
      runtime.getSetting("WORKSPACE_SKILLS_DIR"),
    )) {
      if (fs.existsSync(dir)) skillsDirs.add(dir);
    }
  }

  // Managed skills in the state dir (~/.eliza/skills by default)
  const managedSkills = path.join(resolveStateDir(), "skills");
  if (fs.existsSync(managedSkills)) {
    skillsDirs.add(managedSkills);
  }

  // Workspace-local skills
  const workspaceSkills = path.join(workspaceDir, "skills");
  if (fs.existsSync(workspaceSkills)) {
    skillsDirs.add(workspaceSkills);
  }

  // Marketplace-installed skills (stored under .marketplace, skipped by dot-prefix filter)
  const marketplaceSkills = path.join(workspaceDir, "skills", ".marketplace");
  if (fs.existsSync(marketplaceSkills)) {
    skillsDirs.add(marketplaceSkills);
  }

  // Extra dirs from config
  const extraDirs = config.skills?.load?.extraDirs;
  if (extraDirs) {
    for (const dir of extraDirs) {
      if (fs.existsSync(dir)) skillsDirs.add(dir);
    }
  }

  const skills: SkillEntry[] = [];
  const seen = new Set<string>();

  for (const dir of skillsDirs) {
    scanSkillsDir(dir, skills, seen, config, dbPrefs);
  }

  return skills
    .filter((skill) => shouldExposeBinanceSkillId(skill.id))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Recursively scan a directory for SKILL.md files, applying config filtering.
 */
export function scanSkillsDir(
  dir: string,
  skills: SkillEntry[],
  seen: Set<string>,
  config: ElizaConfig,
  dbPrefs: SkillPreferencesMap,
): void {
  if (!fs.existsSync(dir)) return;

  for (const entry of fs.readdirSync(dir)) {
    if (
      entry.startsWith(".") ||
      entry === "node_modules" ||
      entry === "src" ||
      entry === "dist"
    )
      continue;

    const entryPath = path.join(dir, entry);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(entryPath);
    } catch {
      continue;
    }

    if (!stat.isDirectory()) continue;

    const skillMd = path.join(entryPath, "SKILL.md");
    if (fs.existsSync(skillMd)) {
      if (seen.has(entry)) continue;
      seen.add(entry);

      try {
        const content = fs.readFileSync(skillMd, "utf-8");

        let skillName = entry;
        let description = "";

        // Parse YAML frontmatter
        const fmMatch = /^---\s*\n([\s\S]*?)\n---/.exec(content);
        if (fmMatch) {
          const fmBlock = fmMatch[1];
          const nameMatch = /^name:\s*(.+)$/m.exec(fmBlock);
          const descMatch = /^description:\s*(.+)$/m.exec(fmBlock);
          if (nameMatch)
            skillName = nameMatch[1].trim().replace(/^["']|["']$/g, "");
          if (descMatch)
            description = descMatch[1].trim().replace(/^["']|["']$/g, "");
        }

        // Fallback to heading / first paragraph
        if (!description) {
          const lines = content.split("\n");
          const heading = lines.find((l) => l.trim().startsWith("#"));
          if (heading) skillName = heading.replace(/^#+\s*/, "").trim();
          const descLine = lines.find(
            (l) =>
              l.trim() &&
              !l.trim().startsWith("#") &&
              !l.trim().startsWith("---"),
          );
          description = descLine?.trim() ?? "";
        }

        skills.push({
          id: entry,
          name: skillName,
          description: description.slice(0, 200),
          enabled: resolveSkillEnabled(entry, config, dbPrefs),
        });
      } catch {
        /* skip unreadable */
      }
    } else {
      // Recurse into subdirectories for nested skill groups
      scanSkillsDir(entryPath, skills, seen, config, dbPrefs);
    }
  }
}

// ---------------------------------------------------------------------------
// Request helpers
// ---------------------------------------------------------------------------

/** Maximum request body size (1 MB) — prevents memory-based DoS. */
export const MAX_BODY_BYTES = 1_048_576;

/**
 * Raised body limit for chat endpoints that accept base64-encoded image
 * attachments. A single smartphone JPEG is typically 2–5 MB binary
 * (~3–7 MB base64); 20 MB accommodates up to 4 images with room to spare.
 */
export const CHAT_MAX_BODY_BYTES = 20 * 1_048_576;
const _ELEVENLABS_FETCH_TIMEOUT_MS = 20_000;
const _ELEVENLABS_AUDIO_MAX_BYTES = 20 * 1_048_576;
