#!/usr/bin/env node
/**
 * Ensure required skills exist in the managed skills store.
 *
 * This script is run during startup to seed shipped skills into:
 *   $ELIZA_STATE_DIR/skills
 * or, by default:
 *   ~/.eliza/skills (or ~/.{ELIZA_NAMESPACE}/skills)
 *
 * Run automatically during startup, or manually:
 *   node scripts/ensure-skills.mjs
 */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const SHIPPED_SKILLS_DIR = join(__dirname, "..", "skills");

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
