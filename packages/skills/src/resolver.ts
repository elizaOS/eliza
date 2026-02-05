import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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
