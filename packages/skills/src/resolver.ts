/**
 * Filesystem path resolution for the skills stores: locates the bundled
 * `skills/` directory (cached, with a heuristic sanity check) and the per-user
 * curated `active` / `proposed` directories under the state dir, and promotes a
 * proposed skill to active atomically. `getSkillsDir` is the symbol the agent
 * runtime and plugin-agent-skills call at startup.
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ElizaError, resolveStateDir } from "@elizaos/core";

export const BUNDLED_SKILLS_OVERRIDE_INVALID =
  "BUNDLED_SKILLS_OVERRIDE_INVALID";

let cachedSkillsDir: string | undefined;

function looksLikeSkillsDir(dir: string): boolean {
  if (!existsSync(dir)) {
    return false;
  }

  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // error-policy:J3 unreadable candidate directory on untrusted filesystem is explicitly not a skills dir
    return false;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const fullPath = join(dir, entry.name);
    let isFile = entry.isFile();
    let isDirectory = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try {
        const stats = statSync(fullPath);
        isFile = stats.isFile();
        isDirectory = stats.isDirectory();
      } catch {
        // error-policy:J3 dangling or inaccessible symlink is treated as neither file nor directory
        isFile = false;
        isDirectory = false;
      }
    }
    if (isFile && entry.name.endsWith(".md")) {
      return true;
    }
    if (isDirectory) {
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
 * A nonempty override selects one readable directory, including an empty one.
 * Invalid overrides throw BUNDLED_SKILLS_OVERRIDE_INVALID; automatic discovery
 * is used only when the setting is absent or blank.
 * @throws Error if skills directory cannot be found
 */
export function getSkillsDir(): string {
  if (cachedSkillsDir !== undefined) {
    return cachedSkillsDir;
  }

  const override = process.env.ELIZAOS_BUNDLED_SKILLS_DIR?.trim();
  if (override) {
    const directory = resolve(override);
    try {
      // An explicitly selected empty directory is valid; only automatic
      // discovery needs a heuristic to distinguish bundled skills from other data.
      readdirSync(directory);
    } catch (cause) {
      // error-policy:J2 An invalid explicit selection must not load a different bundle.
      throw new ElizaError(
        `ELIZAOS_BUNDLED_SKILLS_DIR must name a readable directory: ${directory}`,
        {
          code: BUNDLED_SKILLS_OVERRIDE_INVALID,
          cause,
          context: { setting: "ELIZAOS_BUNDLED_SKILLS_DIR", directory },
        },
      );
    }
    cachedSkillsDir = directory;
    return directory;
  }

  const execDir = dirname(process.execPath);
  const siblingSkills = join(execDir, "skills");
  if (looksLikeSkillsDir(siblingSkills)) {
    cachedSkillsDir = siblingSkills;
    return cachedSkillsDir;
  }

  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);

  const packageRoot = dirname(__dirname);
  const packageSkills = join(packageRoot, "skills");

  if (looksLikeSkillsDir(packageSkills)) {
    cachedSkillsDir = packageSkills;
    return cachedSkillsDir;
  }

  const parentPackageSkills = join(dirname(packageRoot), "skills");
  if (looksLikeSkillsDir(parentPackageSkills)) {
    cachedSkillsDir = parentPackageSkills;
    return cachedSkillsDir;
  }

  throw new Error(
    "Could not find bundled skills directory. Set ELIZAOS_BUNDLED_SKILLS_DIR environment variable or ensure skills/ directory exists in package.",
  );
}

export function clearSkillsDirCache(): void {
  cachedSkillsDir = undefined;
}

/** The state root is resolved at call time so hosts can select it after import. */
function resolveCuratedBaseDir(stateDir = resolveStateDir()): string {
  return join(stateDir, "skills", "curated");
}

/**
 * Curated active store selected by loadSkills, relative to the supplied state
 * root or the host's current resolveStateDir() result.
 */
export function getCuratedActiveDir(stateDir?: string): string {
  return join(resolveCuratedBaseDir(stateDir), "active");
}

/**
 * Draft store excluded from automatic loadSkills discovery. Callers can still
 * select drafts deliberately through an explicit skillPaths entry.
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
