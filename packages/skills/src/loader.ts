import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import {
  parseFrontmatter,
  resolveSkillInvocationPolicy,
  resolveSkillMetadata,
  resolveSkillProvenance,
} from "./frontmatter.js";
import { getCuratedActiveDir, getSkillsDir } from "./resolver.js";
import type {
  LoadSkillsFromDirOptions,
  LoadSkillsOptions,
  LoadSkillsResult,
  Skill,
  SkillDiagnostic,
  SkillEntry,
  SkillFrontmatter,
} from "./types.js";

/** Maximum skill name length per Agent Skills spec */
const MAX_NAME_LENGTH = 64;

/** Maximum description length per Agent Skills spec */
const MAX_DESCRIPTION_LENGTH = 1024;

/** Default config directory name */
const CONFIG_DIR_NAME = ".elizaos";

/** Default agent directory for user skills */
const DEFAULT_AGENT_DIR = join(homedir(), CONFIG_DIR_NAME);

/**
 * Validate skill name per Agent Skills spec.
 * Returns array of validation error messages (empty if valid).
 *
 * @param name - The skill name to validate
 * @param parentDirName - The parent directory name (should match)
 * @returns Array of validation error messages
 */
function validateName(name: string, parentDirName: string): string[] {
  const errors: string[] = [];

  if (name !== parentDirName) {
    errors.push(
      `name "${name}" does not match parent directory "${parentDirName}"`,
    );
  }

  if (name.length > MAX_NAME_LENGTH) {
    errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
  }

  if (!/^[a-z0-9-]+$/.test(name)) {
    errors.push(
      `name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)`,
    );
  }

  if (name.startsWith("-") || name.endsWith("-")) {
    errors.push(`name must not start or end with a hyphen`);
  }

  if (name.includes("--")) {
    errors.push(`name must not contain consecutive hyphens`);
  }

  return errors;
}

/**
 * Validate description per Agent Skills spec.
 *
 * @param description - The skill description to validate
 * @returns Array of validation error messages
 */
function validateDescription(description: string | undefined): string[] {
  const errors: string[] = [];

  if (!description || description.trim() === "") {
    errors.push("description is required");
  } else if (description.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(
      `description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`,
    );
  }

  return errors;
}

/**
 * Load a single skill from a SKILL.md file
 *
 * @param filePath - Absolute path to the SKILL.md file
 * @param source - Source identifier for this skill
 * @returns Loaded skill and diagnostics
 */
function loadSkillFromFile(
  filePath: string,
  source: string,
): { skill: Skill | null; diagnostics: SkillDiagnostic[] } {
  const diagnostics: SkillDiagnostic[] = [];

  const rawContent = readFileSync(filePath, "utf-8");
  const { frontmatter } = parseFrontmatter<SkillFrontmatter>(rawContent);
  const skillDir = dirname(filePath);
  const parentDirName = basename(skillDir);

  // Validate description
  const descErrors = validateDescription(frontmatter.description);
  for (const error of descErrors) {
    diagnostics.push({ type: "warning", message: error, path: filePath });
  }

  // Use name from frontmatter, or fall back to parent directory name
  const name = frontmatter.name || parentDirName;

  // Validate name
  const nameErrors = validateName(name, parentDirName);
  for (const error of nameErrors) {
    diagnostics.push({ type: "warning", message: error, path: filePath });
  }

  // Don't load the skill if description is completely missing
  if (!frontmatter.description || frontmatter.description.trim() === "") {
    return { skill: null, diagnostics };
  }

  const provenance = resolveSkillProvenance(frontmatter);

  return {
    skill: {
      name,
      description: frontmatter.description,
      filePath,
      baseDir: skillDir,
      source,
      disableModelInvocation: frontmatter["disable-model-invocation"] === true,
      ...(provenance ? { provenance } : {}),
    },
    diagnostics,
  };
}

/**
 * Internal recursive skill loader
 *
 * @param dir - Directory to scan
 * @param source - Source identifier
 * @param includeRootFiles - Whether to include .md files at root level
 * @returns Loaded skills and diagnostics
 */
function loadSkillsFromDirInternal(
  dir: string,
  source: string,
  includeRootFiles: boolean,
): LoadSkillsResult {
  const skills: Skill[] = [];
  const diagnostics: SkillDiagnostic[] = [];

  if (!existsSync(dir)) {
    return { skills, diagnostics };
  }

  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    // Skip hidden files and directories
    if (entry.name.startsWith(".")) {
      continue;
    }

    // Skip node_modules to avoid scanning dependencies
    if (entry.name === "node_modules") {
      continue;
    }

    const fullPath = join(dir, entry.name);

    // For symlinks, check if they point to a directory and follow them
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      const stats = statSync(fullPath);
      isDirectory = stats.isDirectory();
      isFile = stats.isFile();
    }

    if (isDirectory) {
      const subResult = loadSkillsFromDirInternal(fullPath, source, false);
      skills.push(...subResult.skills);
      diagnostics.push(...subResult.diagnostics);
      continue;
    }

    if (!isFile) {
      continue;
    }

    const isRootMd = includeRootFiles && entry.name.endsWith(".md");
    const isSkillMd = !includeRootFiles && entry.name === "SKILL.md";
    if (!isRootMd && !isSkillMd) {
      continue;
    }

    const result = loadSkillFromFile(fullPath, source);
    if (result.skill) {
      skills.push(result.skill);
    }
    diagnostics.push(...result.diagnostics);
  }

  return { skills, diagnostics };
}

/**
 * Load skills from a single directory.
 *
 * Discovery rules:
 * - Direct .md children in the root
 * - Recursive SKILL.md under subdirectories
 *
 * @param options - Loading options
 * @returns Loaded skills and diagnostics
 */
export function loadSkillsFromDir(
  options: LoadSkillsFromDirOptions,
): LoadSkillsResult {
  const { dir, source } = options;
  return loadSkillsFromDirInternal(dir, source, true);
}

/**
 * Normalize a path, expanding ~ to home directory
 *
 * @param input - Path that may contain ~
 * @returns Normalized absolute path
 */
function normalizePath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  if (trimmed.startsWith("~")) return join(homedir(), trimmed.slice(1));
  return trimmed;
}

/**
 * Resolve a skill path relative to cwd
 *
 * @param p - Path to resolve
 * @param cwd - Current working directory
 * @returns Absolute path
 */
function resolveSkillPath(p: string, cwd: string): string {
  const normalized = normalizePath(p);
  return isAbsolute(normalized) ? normalized : resolve(cwd, normalized);
}

/**
 * Check if a target path is under a root path
 *
 * @param target - Path to check
 * @param root - Root path
 * @returns True if target is under root
 */
function isUnderPath(target: string, root: string): boolean {
  const normalizedRoot = resolve(root);
  if (target === normalizedRoot) {
    return true;
  }
  const prefix = normalizedRoot.endsWith(sep)
    ? normalizedRoot
    : `${normalizedRoot}${sep}`;
  return target.startsWith(prefix);
}

/**
 * Load skills from all configured locations.
 *
 * Sources are loaded in precedence order (later sources override earlier):
 * 1. Bundled skills (from this package)
 * 2. User/managed skills (~/.elizaos/skills)
 * 3. Project skills (<cwd>/.elizaos/skills)
 * 4. Explicit skill paths
 *
 * @param options - Loading options
 * @returns Loaded skills and diagnostics
 */
export function loadSkills(options: LoadSkillsOptions = {}): LoadSkillsResult {
  const {
    cwd = process.cwd(),
    agentDir,
    skillPaths = [],
    includeDefaults = true,
    bundledSkillsDir,
    managedSkillsDir,
  } = options;

  // Resolve directories
  const resolvedAgentDir = agentDir ?? DEFAULT_AGENT_DIR;
  const resolvedBundledDir = bundledSkillsDir ?? getSkillsDir();
  const resolvedManagedDir =
    managedSkillsDir ?? join(resolvedAgentDir, "skills");
  const projectSkillsDir = resolve(cwd, CONFIG_DIR_NAME, "skills");
  const userSkillsDir = join(resolvedAgentDir, "skills");

  const skillMap = new Map<string, Skill>();
  const realPathSet = new Set<string>();
  const allDiagnostics: SkillDiagnostic[] = [];
  const collisionDiagnostics: SkillDiagnostic[] = [];

  function addSkills(result: LoadSkillsResult): void {
    allDiagnostics.push(...result.diagnostics);
    for (const skill of result.skills) {
      // Skip skills without file paths (inline skills) - they can't be deduplicated
      if (!skill.filePath) {
        skillMap.set(skill.name, skill);
        continue;
      }

      // Resolve symlinks to detect duplicate files
      let realPath: string;
      try {
        realPath = realpathSync(skill.filePath);
      } catch {
        realPath = skill.filePath;
      }

      // Skip silently if we've already loaded this exact file (via symlink)
      if (realPathSet.has(realPath)) {
        continue;
      }

      const existing = skillMap.get(skill.name);
      if (existing) {
        collisionDiagnostics.push({
          type: "collision",
          message: `name "${skill.name}" collision`,
          path: skill.filePath,
          collision: {
            resourceType: "skill",
            name: skill.name,
            winnerPath: skill.filePath,
            loserPath: existing.filePath ?? "(inline)",
          },
        });
      }
      skillMap.set(skill.name, skill);
      realPathSet.add(realPath);
    }
  }

  if (includeDefaults) {
    // Load in precedence order: bundled < managed < curated < project.
    // The curated namespace holds agent-derived skills that were promoted to
    // "active" by the closed learning loop or the user. Skills under the
    // sibling "proposed" directory are intentionally NOT scanned here — they
    // are pending human review and only surfaced via the curated-skills API.
    if (resolvedBundledDir) {
      addSkills(loadSkillsFromDirInternal(resolvedBundledDir, "bundled", true));
    }
    addSkills(loadSkillsFromDirInternal(resolvedManagedDir, "managed", true));
    addSkills(
      loadSkillsFromDirInternal(getCuratedActiveDir(), "curated", true),
    );
    addSkills(loadSkillsFromDirInternal(projectSkillsDir, "project", true));
  }

  // Determine source for explicit paths
  const getSource = (resolvedPath: string): "user" | "project" | "path" => {
    if (!includeDefaults) {
      if (isUnderPath(resolvedPath, userSkillsDir)) return "user";
      if (isUnderPath(resolvedPath, projectSkillsDir)) return "project";
    }
    return "path";
  };

  // Load explicit skill paths
  for (const rawPath of skillPaths) {
    const resolvedPath = resolveSkillPath(rawPath, cwd);
    if (!existsSync(resolvedPath)) {
      allDiagnostics.push({
        type: "warning",
        message: "skill path does not exist",
        path: resolvedPath,
      });
      continue;
    }

    const stats = statSync(resolvedPath);
    const source = getSource(resolvedPath);
    if (stats.isDirectory()) {
      addSkills(loadSkillsFromDirInternal(resolvedPath, source, true));
    } else if (stats.isFile() && resolvedPath.endsWith(".md")) {
      const result = loadSkillFromFile(resolvedPath, source);
      if (result.skill) {
        addSkills({ skills: [result.skill], diagnostics: result.diagnostics });
      } else {
        allDiagnostics.push(...result.diagnostics);
      }
    } else {
      allDiagnostics.push({
        type: "warning",
        message: "skill path is not a markdown file",
        path: resolvedPath,
      });
    }
  }

  return {
    skills: Array.from(skillMap.values()),
    diagnostics: [...allDiagnostics, ...collisionDiagnostics],
  };
}

/**
 * Load skill entries with full metadata parsing
 *
 * @param options - Loading options
 * @returns Skill entries with parsed metadata
 */
export function loadSkillEntries(
  options: LoadSkillsOptions = {},
): SkillEntry[] {
  const { skills } = loadSkills(options);

  return skills.map((skill) => {
    let frontmatter: SkillFrontmatter = {};
    // Only parse frontmatter for file-based skills
    if (skill.filePath) {
      try {
        const raw = readFileSync(skill.filePath, "utf-8");
        const parsed = parseFrontmatter<SkillFrontmatter>(raw);
        frontmatter = parsed.frontmatter;
      } catch {
        // Use empty frontmatter if parsing fails
      }
    }

    return {
      skill,
      frontmatter,
      metadata: resolveSkillMetadata(frontmatter),
      invocation: resolveSkillInvocationPolicy(frontmatter),
    };
  });
}
