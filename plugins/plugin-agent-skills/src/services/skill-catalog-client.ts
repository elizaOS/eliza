/**
 * Skill Catalog Client for Eliza.
 *
 * Provides a cached skill catalog (memory -> file) sourced from the
 * local skills/.cache/catalog.json. Supports search and browse.
 *
 * @module services/skill-catalog-client
 */

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { logger } from "@elizaos/core";

export interface CatalogSkillStats {
  comments: number;
  downloads: number;
  installsAllTime: number;
  installsCurrent: number;
  stars: number;
  versions: number;
}

export interface CatalogSkillVersion {
  version: string;
  createdAt: number;
  changelog: string;
}

export interface CatalogSkill {
  slug: string;
  displayName: string;
  summary: string | null;
  tags: Record<string, string>;
  stats: CatalogSkillStats;
  createdAt: number;
  updatedAt: number;
  latestVersion: CatalogSkillVersion | null;
}

export interface CatalogSearchResult {
  slug: string;
  displayName: string;
  summary: string | null;
  score: number;
  latestVersion: string | null;
  downloads: number;
  stars: number;
  installs: number;
}

let memoryCache: {
  skills: CatalogSkill[];
  loadedAt: number;
} | null = null;

const MEMORY_TTL_MS = 600_000;

function findCatalogPaths(): string[] {
  const paths: string[] = [];

  const envPath = process.env.ELIZA_SKILLS_CATALOG?.trim();
  if (envPath) return [envPath];

  let dir = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    paths.push(path.join(dir, "skills", ".cache", "catalog.json"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  if (home) {
    paths.push(path.join(home, ".eliza", "skills", "catalog.json"));
  }

  return paths;
}

async function readCatalogFile(): Promise<CatalogSkill[] | null> {
  for (const catalogPath of findCatalogPaths()) {
    try {
      const raw = await fs.readFile(catalogPath, "utf-8");
      const parsed = JSON.parse(raw) as {
        data?: CatalogSkill[];
        cachedAt?: number;
      };
      if (Array.isArray(parsed.data) && parsed.data.length > 0) {
        logger.debug(
          `[skill-catalog] Loaded ${parsed.data.length} skills from ${catalogPath}`,
        );
        return parsed.data;
      }
    } catch {
      // Try next path.
    }
  }
  return null;
}

export async function getCatalogSkills(): Promise<CatalogSkill[]> {
  if (memoryCache && Date.now() - memoryCache.loadedAt < MEMORY_TTL_MS) {
    return memoryCache.skills;
  }

  const skills = await readCatalogFile();
  if (!skills) {
    logger.warn("[skill-catalog] No catalog file found");
    return [];
  }

  memoryCache = { skills, loadedAt: Date.now() };
  return skills;
}

export async function refreshCatalog(): Promise<CatalogSkill[]> {
  memoryCache = null;
  return getCatalogSkills();
}

export async function getCatalogSkill(
  slug: string,
): Promise<CatalogSkill | null> {
  const skills = await getCatalogSkills();
  return skills.find((s) => s.slug === slug) ?? null;
}

export async function searchCatalogSkills(
  query: string,
  limit = 30,
): Promise<CatalogSearchResult[]> {
  const skills = await getCatalogSkills();
  const lq = query.toLowerCase();
  const terms = lq.split(/\s+/).filter((t) => t.length > 1);

  const scored: Array<{ s: CatalogSkill; score: number }> = [];

  for (const skill of skills) {
    const slug = skill.slug.toLowerCase();
    const name = (skill.displayName ?? "").toLowerCase();
    const summary = (skill.summary ?? "").toLowerCase();
    let score = 0;

    if (slug === lq || name === lq) score += 100;
    else if (slug.includes(lq)) score += 50;
    else if (name.includes(lq)) score += 45;

    if (summary.includes(lq)) score += 30;

    for (const tag of Object.keys(skill.tags)) {
      if (tag.toLowerCase().includes(lq)) score += 20;
    }

    for (const term of terms) {
      if (slug.includes(term)) score += 15;
      if (name.includes(term)) score += 12;
      if (summary.includes(term)) score += 8;
    }

    if (score > 0) {
      if (skill.stats.downloads > 50) score += 3;
      if (skill.stats.downloads > 200) score += 3;
      if (skill.stats.stars > 0) score += 2;
      if (skill.stats.installsCurrent > 0) score += 2;
      scored.push({ s: skill, score });
    }
  }

  scored.sort(
    (a, b) => b.score - a.score || b.s.stats.downloads - a.s.stats.downloads,
  );
  const max = scored[0]?.score || 1;

  return scored.slice(0, limit).map(({ s, score }) => ({
    slug: s.slug,
    displayName: s.displayName,
    summary: s.summary,
    score: score / max,
    latestVersion: s.latestVersion?.version ?? null,
    downloads: s.stats.downloads,
    stars: s.stats.stars,
    installs: s.stats.installsAllTime,
  }));
}

export async function getTrendingSkills(limit = 30): Promise<CatalogSkill[]> {
  const skills = await getCatalogSkills();
  return [...skills]
    .sort(
      (a, b) =>
        b.stats.downloads - a.stats.downloads || b.updatedAt - a.updatedAt,
    )
    .slice(0, limit);
}
