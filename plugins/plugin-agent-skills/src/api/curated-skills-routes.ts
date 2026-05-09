/**
 * Routes for the curated learning loop ("Learned Skills" surface).
 *
 * The closed learning loop writes derived/refined skills under
 * ~/.eliza/skills/curated/{active,proposed}. These routes power the
 * Settings → Learned Skills panel so the user can review proposals, promote
 * them to active, disable, edit, or delete.
 *
 * Routes are mounted under /api/skills/curated/* to avoid collision with the
 * pre-existing /api/skills/* routes in skills-routes.ts (which manage the
 * separate marketplace/workspace-skills surface).
 */

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { resolveStateDir } from "@elizaos/agent";
import { logger, type RouteRequestContext } from "@elizaos/core";

const CURATED_SKILL_NAME_RE = /^[a-z0-9-]+$/;

interface CuratedProvenance {
  source: "human" | "agent-generated" | "agent-refined";
  derivedFromTrajectory?: string;
  createdAt: string;
  refinedCount: number;
  lastEvalScore?: number;
}

interface CuratedSkillSummary {
  name: string;
  description: string;
  source: "human" | "agent-generated" | "agent-refined";
  derivedFromTrajectory?: string;
  createdAt: string;
  refinedCount: number;
  lastEvalScore?: number;
  status: "active" | "proposed" | "disabled";
  filePath: string;
}

function curatedActiveDir(): string {
  return join(resolveStateDir(), "skills", "curated", "active");
}

function curatedProposedDir(): string {
  return join(resolveStateDir(), "skills", "curated", "proposed");
}

function curatedDisabledDir(): string {
  return join(resolveStateDir(), "skills", "curated", "disabled");
}

function isValidName(name: string): boolean {
  return (
    CURATED_SKILL_NAME_RE.test(name) &&
    !name.startsWith("-") &&
    !name.endsWith("-") &&
    !name.includes("--") &&
    name.length <= 64
  );
}

function listSkillEntries(
  dir: string,
  status: CuratedSkillSummary["status"],
): CuratedSkillSummary[] {
  if (!existsSync(dir)) return [];
  const entries = readdirSync(dir, { withFileTypes: true });
  const out: CuratedSkillSummary[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    const skillDir = join(dir, entry.name);
    const skillFile = join(skillDir, "SKILL.md");
    if (!existsSync(skillFile)) continue;
    const parsed = parseSkillFile(readFileSync(skillFile, "utf-8"));
    if (!parsed) continue;
    const provenance = parsed.provenance ?? {
      source: "human" as const,
      createdAt: new Date().toISOString(),
      refinedCount: 0,
    };
    out.push({
      name: entry.name,
      description: parsed.description ?? "",
      source: provenance.source,
      derivedFromTrajectory: provenance.derivedFromTrajectory,
      createdAt: provenance.createdAt,
      refinedCount: provenance.refinedCount,
      lastEvalScore: provenance.lastEvalScore,
      status,
      filePath: skillFile,
    });
  }
  return out.sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
  );
}

interface ParsedSkill {
  name?: string;
  description?: string;
  provenance?: CuratedProvenance;
  body: string;
}

function parseSkillFile(content: string): ParsedSkill | null {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---")) {
    return { body: normalized };
  }
  const endIdx = normalized.indexOf("\n---", 3);
  if (endIdx === -1) {
    return { body: normalized };
  }
  const yamlBlock = normalized.slice(4, endIdx);
  const body = normalized.slice(endIdx + 4).replace(/^\n+/, "");

  const parsed: ParsedSkill = { body };
  const provenance: Partial<CuratedProvenance> = {};
  let inProvenance = false;
  for (const rawLine of yamlBlock.split("\n")) {
    const line = rawLine.replace(/\s+$/, "");
    if (!line) {
      inProvenance = false;
      continue;
    }
    if (/^[a-zA-Z]/.test(line)) {
      inProvenance = false;
      const [keyRaw, ...rest] = line.split(":");
      const key = keyRaw?.trim();
      const value = rest.join(":").trim();
      if (key === "name") parsed.name = stripQuotes(value);
      else if (key === "description") parsed.description = stripQuotes(value);
      else if (key === "provenance") inProvenance = true;
    } else if (inProvenance && /^\s+\S/.test(rawLine)) {
      const trimmed = rawLine.trim();
      const [keyRaw, ...rest] = trimmed.split(":");
      const key = keyRaw?.trim();
      const value = rest.join(":").trim();
      if (!key) continue;
      if (key === "source") {
        const v = stripQuotes(value);
        if (v === "human" || v === "agent-generated" || v === "agent-refined") {
          provenance.source = v;
        }
      } else if (key === "createdAt") provenance.createdAt = stripQuotes(value);
      else if (key === "derivedFromTrajectory")
        provenance.derivedFromTrajectory = stripQuotes(value);
      else if (key === "refinedCount") {
        const n = Number(value);
        provenance.refinedCount = Number.isFinite(n) ? n : 0;
      } else if (key === "lastEvalScore") {
        const n = Number(value);
        if (Number.isFinite(n)) provenance.lastEvalScore = n;
      }
    } else {
      inProvenance = false;
    }
  }

  if (
    provenance.source &&
    typeof provenance.createdAt === "string" &&
    typeof provenance.refinedCount === "number"
  ) {
    parsed.provenance = provenance as CuratedProvenance;
  }
  return parsed;
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function moveSkillDirectory(src: string, dest: string): void {
  const parent = join(dest, "..");
  if (!existsSync(parent)) {
    mkdirSync(parent, { recursive: true });
  }
  if (existsSync(dest)) {
    throw new Error(`destination already exists: ${dest}`);
  }
  // Try a same-volume rename first; fall back to recursive copy + remove for
  // cross-volume moves (e.g. tmpdir → home on some CI runners).
  try {
    renameSync(src, dest);
  } catch {
    cpSync(src, dest, { recursive: true });
    rmSync(src, { recursive: true, force: true });
  }
}

interface CuratedSkillsRouteContext extends RouteRequestContext {
  url: URL;
}

/**
 * Returns true if the request was handled (and a response written).
 */
export async function handleCuratedSkillsRoutes(
  ctx: CuratedSkillsRouteContext,
): Promise<boolean> {
  const { req, res, method, pathname, json, error, readJsonBody } = ctx;

  if (!pathname.startsWith("/api/skills/curated")) {
    return false;
  }

  // GET /api/skills/curated — list curated skills (active + proposed + disabled)
  if (method === "GET" && pathname === "/api/skills/curated") {
    const active = listSkillEntries(curatedActiveDir(), "active");
    const proposed = listSkillEntries(curatedProposedDir(), "proposed");
    const disabled = listSkillEntries(curatedDisabledDir(), "disabled");
    json(res, {
      ok: true,
      skills: [...active, ...proposed, ...disabled],
      counts: {
        active: active.length,
        proposed: proposed.length,
        disabled: disabled.length,
      },
    });
    return true;
  }

  // POST /api/skills/curated/:name/promote — proposed → active
  const promoteMatch = pathname.match(
    /^\/api\/skills\/curated\/([a-z0-9-]+)\/promote$/,
  );
  if (method === "POST" && promoteMatch) {
    const name = promoteMatch[1];
    if (!name || !isValidName(name)) {
      error(res, "Invalid skill name", 400);
      return true;
    }
    const proposedSkillDir = join(curatedProposedDir(), name);
    const activeSkillDir = join(curatedActiveDir(), name);
    if (
      !existsSync(proposedSkillDir) ||
      !statSync(proposedSkillDir).isDirectory()
    ) {
      error(res, `Proposed skill "${name}" not found`, 404);
      return true;
    }
    if (existsSync(activeSkillDir)) {
      error(res, `Active skill "${name}" already exists`, 409);
      return true;
    }
    moveSkillDirectory(proposedSkillDir, activeSkillDir);
    logger.info(`[curated-skills] promoted "${name}" to active`);
    json(res, { ok: true, name, path: activeSkillDir });
    return true;
  }

  // POST /api/skills/curated/:name/disable — active → disabled
  const disableMatch = pathname.match(
    /^\/api\/skills\/curated\/([a-z0-9-]+)\/disable$/,
  );
  if (method === "POST" && disableMatch) {
    const name = disableMatch[1];
    if (!name || !isValidName(name)) {
      error(res, "Invalid skill name", 400);
      return true;
    }
    const activeSkillDir = join(curatedActiveDir(), name);
    const disabledSkillDir = join(curatedDisabledDir(), name);
    if (!existsSync(activeSkillDir)) {
      error(res, `Active curated skill "${name}" not found`, 404);
      return true;
    }
    if (existsSync(disabledSkillDir)) {
      error(res, `Disabled skill "${name}" already exists`, 409);
      return true;
    }
    moveSkillDirectory(activeSkillDir, disabledSkillDir);
    logger.info(`[curated-skills] disabled "${name}"`);
    json(res, { ok: true, name, path: disabledSkillDir });
    return true;
  }

  // DELETE /api/skills/curated/:name — remove from any of the three buckets
  const deleteMatch = pathname.match(/^\/api\/skills\/curated\/([a-z0-9-]+)$/);
  if (method === "DELETE" && deleteMatch) {
    const name = deleteMatch[1];
    if (!name || !isValidName(name)) {
      error(res, "Invalid skill name", 400);
      return true;
    }
    const candidates = [
      join(curatedActiveDir(), name),
      join(curatedProposedDir(), name),
      join(curatedDisabledDir(), name),
    ];
    let removedFrom: string | null = null;
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        rmSync(candidate, { recursive: true, force: true });
        removedFrom = candidate;
        break;
      }
    }
    if (!removedFrom) {
      error(res, `Curated skill "${name}" not found`, 404);
      return true;
    }
    logger.info(`[curated-skills] deleted "${name}" from ${removedFrom}`);
    json(res, { ok: true, name, path: removedFrom });
    return true;
  }

  // PUT /api/skills/curated/:name/source — overwrite SKILL.md body for an
  // active or proposed skill (used by the Learned Skills "edit" affordance).
  const sourceMatch = pathname.match(
    /^\/api\/skills\/curated\/([a-z0-9-]+)\/source$/,
  );
  if (method === "PUT" && sourceMatch) {
    const name = sourceMatch[1];
    if (!name || !isValidName(name)) {
      error(res, "Invalid skill name", 400);
      return true;
    }
    const body = await readJsonBody<{ content?: string }>(req, res);
    if (!body) return true;
    if (typeof body.content !== "string") {
      error(res, "Missing 'content' field", 400);
      return true;
    }
    const candidates = [
      join(curatedActiveDir(), name, "SKILL.md"),
      join(curatedProposedDir(), name, "SKILL.md"),
    ];
    const target = candidates.find((path) => existsSync(path));
    if (!target) {
      error(res, `Curated skill "${name}" not found`, 404);
      return true;
    }
    writeFileSync(target, body.content, "utf-8");
    json(res, { ok: true, name, path: target });
    return true;
  }

  return false;
}
