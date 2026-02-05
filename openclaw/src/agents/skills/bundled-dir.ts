import fs from "node:fs";
import path from "node:path";
import { getSkillsDir } from "@elizaos/skills";

export type BundledSkillsResolveOptions = {
  argv1?: string;
  moduleUrl?: string;
  cwd?: string;
  execPath?: string;
};

/**
 * Resolve the bundled skills directory.
 *
 * Resolution order:
 * 1. OPENCLAW_BUNDLED_SKILLS_DIR environment variable (backwards compatibility)
 * 2. Sibling `skills/` next to the executable (for compiled binaries)
 * 3. @elizaos/skills package's bundled skills directory
 *
 * @param opts - Resolution options (for backwards compatibility, mostly unused now)
 * @returns Absolute path to skills directory, or undefined if not found
 */
export function resolveBundledSkillsDir(
  opts: BundledSkillsResolveOptions = {},
): string | undefined {
  // Check OPENCLAW_BUNDLED_SKILLS_DIR env var for backwards compatibility
  const override = process.env.OPENCLAW_BUNDLED_SKILLS_DIR?.trim();
  if (override && fs.existsSync(override)) {
    return override;
  }

  // For compiled binaries: check sibling skills/ next to executable
  const execPath = opts.execPath ?? process.execPath;
  const execDir = path.dirname(execPath);
  const siblingSkills = path.join(execDir, "skills");
  if (fs.existsSync(siblingSkills)) {
    return siblingSkills;
  }

  // Delegate to @elizaos/skills package
  return getSkillsDir();
}
