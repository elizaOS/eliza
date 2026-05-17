#!/usr/bin/env node
/**
 * Ensure required skills exist in the managed skills store.
 *
 * Shipped skill assets come from `@elizaos/skills` (`skills/` inside that package).
 * Seeds into:
 *   $ELIZA_STATE_DIR/skills
 * or, by default for Eliza:
 *   ~/.eliza/skills
 *
 * Run automatically during startup, or manually:
 *   node scripts/ensure-skills.mjs
 */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRepoRootFromImportMeta } from "./lib/repo-root.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
export const REPO_ROOT = resolveRepoRootFromImportMeta(import.meta.url);

const require = createRequire(import.meta.url);

export function hasShippedSkillTree(dir) {
  if (!existsSync(dir)) {
    return false;
  }
  for (const name of readdirSync(dir)) {
    if (name.startsWith(".")) {
      continue;
    }
    try {
      if (
        statSync(join(dir, name)).isDirectory() &&
        existsSync(join(dir, name, "SKILL.md"))
      ) {
        return true;
      }
    } catch {
      // ignore unreadable entries
    }
  }
  return false;
}

export function resolveRepoBundledSkillsAssetsDir(repoRoot = REPO_ROOT) {
  const repoDir = join(repoRoot, "eliza", "packages", "skills", "skills");
  if (hasShippedSkillTree(repoDir)) {
    return repoDir;
  }
  throw new Error(`Could not resolve repo-local bundled skills at ${repoDir}.`);
}

/**
 * Resolve the directory containing bundled skill folders (each with SKILL.md).
 * Prefer installed `@elizaos/skills`; fall back to repo-local `eliza/packages/skills/skills` for bootstrap.
 */
export function resolveShippedSkillsAssetsDir() {
  try {
    const pkgJson = require.resolve("@elizaos/skills/package.json");
    const dir = join(dirname(pkgJson), "skills");
    if (hasShippedSkillTree(dir)) {
      return dir;
    }
  } catch {
    // Package not resolvable yet (e.g. before first install).
  }

  try {
    return resolveRepoBundledSkillsAssetsDir();
  } catch {
    // Repo-local skills tree not available.
  }

  throw new Error(
    "Could not resolve bundled skills. Install dependencies (bun install) so @elizaos/skills is available, or ensure eliza/packages/skills/skills exists.",
  );
}

export const SHIPPED_SKILLS_DIR = resolveShippedSkillsAssetsDir();

function resolveUserPath(input, home = homedir) {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    return resolve(trimmed.replace(/^~(?=$|[\\/])/, home()));
  }
  return resolve(trimmed);
}

export function resolveStateDir(env = process.env, home = homedir) {
  const override = env.ELIZA_STATE_DIR?.trim();
  if (override) {
    return resolveUserPath(override, home);
  }
  const namespace = env.ELIZA_NAMESPACE?.trim();
  return join(home(), `.${namespace || "eliza"}`);
}

export function resolveSkillsDir(env = process.env, home = homedir) {
  return join(resolveStateDir(env, home), "skills");
}

function shippedSkillIds(assetsDir = SHIPPED_SKILLS_DIR) {
  return readdirSync(assetsDir)
    .filter((entry) => {
      if (entry.startsWith(".")) return false;
      try {
        return statSync(join(assetsDir, entry)).isDirectory();
      } catch {
        return false;
      }
    })
    .sort();
}

export function ensureSkillsDir(skillsDir = resolveSkillsDir()) {
  if (!existsSync(skillsDir)) {
    console.log(`[ensure-skills] Creating ${skillsDir}...`);
    mkdirSync(skillsDir, { recursive: true });
  }
}

export function ensureShippedSkill(
  skillId,
  { skillsDir = resolveSkillsDir(), assetsDir = SHIPPED_SKILLS_DIR } = {},
) {
  const sourceDir = join(assetsDir, skillId);
  const targetDir = join(skillsDir, skillId);
  const targetSkillPath = join(targetDir, "SKILL.md");

  if (!existsSync(sourceDir)) {
    throw new Error(`Missing shipped skill asset: ${sourceDir}`);
  }

  if (existsSync(targetSkillPath)) {
    console.log(`[ensure-skills] ${skillId} skill already exists`);
    return false;
  }

  console.log(`[ensure-skills] Creating ${skillId} skill...`);
  mkdirSync(targetDir, { recursive: true });
  cpSync(sourceDir, targetDir, { recursive: true, force: true });
  console.log(`[ensure-skills] ${skillId} skill created`);
  return true;
}

export function ensureShippedSkills({
  skillsDir = resolveSkillsDir(),
  assetsDir = SHIPPED_SKILLS_DIR,
} = {}) {
  ensureSkillsDir(skillsDir);

  const created = [];
  for (const skillId of shippedSkillIds(assetsDir)) {
    if (ensureShippedSkill(skillId, { skillsDir, assetsDir })) {
      created.push(skillId);
    }
  }
  return created;
}

export function main() {
  ensureShippedSkills();
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === resolve(__filename);

if (isMain) {
  main();
}
