/**
 * Install bundled Claude Code skills into the host's `~/.claude/skills/` so
 * sub-agents Eliza spawns automatically have access to them.
 *
 * The orchestrator ships skill content under `assets/claude-code-skills/`
 * inside this package. On PTY service init, the installer copies any
 * directory tree under that path into the host's `~/.claude/skills/<id>/`
 * if the destination does not already exist. Subsequent runs are no-ops
 * unless the destination has been removed.
 *
 * Why "skip if exists" rather than "always overwrite":
 * - Skills are user-modifiable. If a user customized eliza-runtime locally
 *   (added their own scripts, edited a reference), the orchestrator should
 *   not silently stomp their edits on every restart.
 * - The cost of a stale skill is that new orchestrator features the skill
 *   should advertise won't be available until the user refreshes manually.
 *   That's the right trade-off for v1; future versions can use a version
 *   marker file to detect "I have an older copy, please update."
 *
 * The installer is best-effort — failures (missing source dir, can't write
 * to home, etc.) log a warning and return; they never block PTY start.
 */

import { cpSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Logger } from "@elizaos/core";

/**
 * Where the bundled skill source lives inside this package. Resolved by
 * walking upward from this module's location until we find the assets dir.
 *
 * The walk-up handles the three concrete shapes this code runs in:
 *   - source dev: src/services/claude-code-skill-installer.ts → walk up 2
 *   - bun-bundled: dist/index.js (everything flattened)         → walk up 1
 *   - tsc-emitted: dist/services/claude-code-skill-installer.js → walk up 2
 *
 * Search-by-presence is more robust than counting `..`s and avoids breaking
 * silently when the bundler shape changes.
 */
function resolveBundledSkillsRoot(): string | null {
  try {
    const here = fileURLToPath(import.meta.url);
    let dir = dirname(here);
    for (let i = 0; i < 5; i++) {
      const candidate = join(dir, "assets", "claude-code-skills");
      if (existsSync(candidate)) {
        return candidate;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return null;
  } catch {
    return null;
  }
}

function resolveClaudeSkillsDir(home: () => string = homedir): string {
  return join(home(), ".claude", "skills");
}

/**
 * Copy each top-level directory under `assets/claude-code-skills/` into
 * `~/.claude/skills/<dirname>/`, skipping any destination that already
 * exists. Returns the list of skill ids that were freshly installed (empty
 * array means everything was already present or the source was missing).
 */
export function ensureBundledClaudeCodeSkills(
  logger: Pick<Logger, "info" | "warn">,
  options: { home?: () => string } = {},
): string[] {
  const installed: string[] = [];
  const sourceRoot = resolveBundledSkillsRoot();
  if (!sourceRoot) {
    // No bundled skills shipped — silent return is fine.
    return installed;
  }

  let entries: string[];
  try {
    entries = readdirSync(sourceRoot);
  } catch (err) {
    logger.warn(
      `[claude-code-skill-installer] could not list ${sourceRoot}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return installed;
  }

  const home = options.home ?? homedir;
  const destRoot = resolveClaudeSkillsDir(home);

  for (const entry of entries) {
    if (entry.startsWith(".")) continue;
    const sourceDir = join(sourceRoot, entry);
    try {
      if (!statSync(sourceDir).isDirectory()) continue;
    } catch {
      continue;
    }

    const destDir = join(destRoot, entry);
    if (existsSync(destDir)) {
      // Already there — leave any user customizations alone.
      continue;
    }

    try {
      mkdirSync(destRoot, { recursive: true });
      cpSync(sourceDir, destDir, { recursive: true });
      installed.push(entry);
      logger.info(
        `[claude-code-skill-installer] installed ${entry} → ${destDir}`,
      );
    } catch (err) {
      logger.warn(
        `[claude-code-skill-installer] failed to install ${entry}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return installed;
}
