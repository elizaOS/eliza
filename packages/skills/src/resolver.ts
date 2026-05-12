import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveStateDir } from "@elizaos/core";

/**
 * Cached skills directory path
 */
let cachedSkillsDir: string | undefined;

/**
 * Check if a directory looks like a skills directory
 * (contains subdirectories with SKILL.md files or .md files directly)
 *
 * @param dir - Directory to check
 * @returns True if directory appears to contain skills
 */
function looksLikeSkillsDir(dir: string): boolean {
  if (!existsSync(dir)) {
    return false;
  }

  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const fullPath = join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".md")) {
      return true;
    }
    if (entry.isDirectory()) {
      if (existsSync(join(fullPath, "SKILL.md"))) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Get the absolute path to the bundled skills directory.
 *
 * Resolution order:
 * 1. ELIZAOS_BUNDLED_SKILLS_DIR environment variable
 * 2. Sibling `skills/` next to the executable (for compiled binaries)
 * 3. Package's own `skills/` directory (relative to this module)
 *
 * @returns Absolute path to the skills directory
 * @throws Error if skills directory cannot be found
 */
export function getSkillsDir(): string {
  // Return cached value if available
  if (cachedSkillsDir !== undefined) {
    return cachedSkillsDir;
  }

  // Check environment variable override
  const override = process.env.ELIZAOS_BUNDLED_SKILLS_DIR?.trim();
  if (override && existsSync(override)) {
    cachedSkillsDir = override;
    return cachedSkillsDir;
  }

  // For compiled binaries: check sibling skills/ next to executable
  const execDir = dirname(process.execPath);
  const siblingSkills = join(execDir, "skills");
  if (looksLikeSkillsDir(siblingSkills)) {
    cachedSkillsDir = siblingSkills;
    return cachedSkillsDir;
  }

  // Resolve relative to this module (packages/skills/dist/resolver.js -> packages/skills/skills)
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  // In development: packages/skills/src/resolver.ts -> packages/skills/skills
  // In production: packages/skills/dist/resolver.js -> packages/skills/skills
  const packageRoot = dirname(__dirname); // Go up from src/ or dist/
  const packageSkills = join(packageRoot, "skills");

  if (looksLikeSkillsDir(packageSkills)) {
    cachedSkillsDir = packageSkills;
    return cachedSkillsDir;
  }

  // Also check one more level up in case we're in a nested dist structure
  const parentPackageSkills = join(dirname(packageRoot), "skills");
  if (looksLikeSkillsDir(parentPackageSkills)) {
    cachedSkillsDir = parentPackageSkills;
    return cachedSkillsDir;
  }

  throw new Error(
    "Could not find bundled skills directory. Set ELIZAOS_BUNDLED_SKILLS_DIR environment variable or ensure skills/ directory exists in package.",
  );
}

/**
 * Clear the cached skills directory path.
 * Useful for testing or when the directory may have changed.
 */
export function clearSkillsDirCache(): void {
  cachedSkillsDir = undefined;
}

/**
 * Default base directory for the curated learning loop. Lives alongside the
 * Eliza state dir (`~/.eliza/`) and holds two sibling namespaces:
 *
 *   curated/active/    — auto-promoted or human-promoted skills (loaded)
 *   curated/proposed/  — staged drafts awaiting human review (NOT loaded)
 *
 * Honors the state directory resolved by @elizaos/core; falls back to
 * `~/.eliza`.
 */
function resolveCuratedBaseDir(): string {
  return join(resolveStateDir(), "skills", "curated");
}

/**
 * Absolute path to the curated **active** skills directory. Skills here are
 * loaded into the runtime alongside bundled and managed skills.
 */
export function getCuratedActiveDir(): string {
  return join(resolveCuratedBaseDir(), "active");
}

/**
 * Absolute path to the curated **proposed** skills directory. Skills here are
 * NEVER loaded into the runtime — they are staged for human review via the
 * Settings → Learned Skills UI.
 */
export function getProposedSkillsDir(): string {
  return join(resolveCuratedBaseDir(), "proposed");
}

/**
 * Promote a proposed skill to active by moving its directory atomically.
 * Returns the destination path. Throws if the source does not exist or the
 * destination already exists.
 */
export function promoteSkill(name: string): string {
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new Error(
      `Invalid skill name "${name}" — must be lowercase a-z, 0-9, hyphens only`,
    );
  }
  const proposedDir = join(getProposedSkillsDir(), name);
  if (!existsSync(proposedDir) || !statSync(proposedDir).isDirectory()) {
    throw new Error(`Proposed skill "${name}" not found at ${proposedDir}`);
  }
  const activeRoot = getCuratedActiveDir();
  if (!existsSync(activeRoot)) {
    mkdirSync(activeRoot, { recursive: true });
  }
  const activeDir = join(activeRoot, name);
  if (existsSync(activeDir)) {
    throw new Error(`Active skill "${name}" already exists at ${activeDir}`);
  }
  renameSync(proposedDir, activeDir);
  return activeDir;
}
