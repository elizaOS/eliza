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

const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;
const CONFIG_DIR_NAME = ".elizaos";
const DEFAULT_AGENT_DIR = join(homedir(), CONFIG_DIR_NAME);

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

function loadSkillFromFile(
  filePath: string,
  source: string,
): { skill: Skill | null; diagnostics: SkillDiagnostic[] } {
  const diagnostics: SkillDiagnostic[] = [];

  const rawContent = readFileSync(filePath, "utf-8");
  const { frontmatter } = parseFrontmatter<SkillFrontmatter>(rawContent);
  const skillDir = dirname(filePath);
  const parentDirName = basename(skillDir);

  const descErrors = validateDescription(frontmatter.description);
  for (const error of descErrors) {
    diagnostics.push({ type: "warning", message: error, path: filePath });
  }

  const name = frontmatter.name || parentDirName;

  const nameErrors = validateName(name, parentDirName);
  for (const error of nameErrors) {
    diagnostics.push({ type: "warning", message: error, path: filePath });
  }

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
    if (entry.name.startsWith(".")) {
      continue;
    }

    if (entry.name === "node_modules") {
      continue;
    }

    const fullPath = join(dir, entry.name);

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

function normalizePath(input: string): string {
  const trimmed = input.trim();
  if (trimmed === "~") return homedir();
  if (trimmed.startsWith("~/")) return join(homedir(), trimmed.slice(2));
  if (trimmed.startsWith("~")) return join(homedir(), trimmed.slice(1));
  return trimmed;
}

function resolveSkillPath(p: string, cwd: string): string {
  const normalized = normalizePath(p);
  return isAbsolute(normalized) ? normalized : resolve(cwd, normalized);
}

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
      if (!skill.filePath) {
        skillMap.set(skill.name, skill);
        continue;
      }

      let realPath: string;
      try {
        realPath = realpathSync(skill.filePath);
      } catch {
        realPath = skill.filePath;
      }

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
    if (resolvedBundledDir) {
      addSkills(loadSkillsFromDirInternal(resolvedBundledDir, "bundled", true));
    }
    addSkills(loadSkillsFromDirInternal(resolvedManagedDir, "managed", true));
    addSkills(
      loadSkillsFromDirInternal(getCuratedActiveDir(), "curated", true),
    );
    addSkills(loadSkillsFromDirInternal(projectSkillsDir, "project", true));
  }

  const getSource = (resolvedPath: string): "user" | "project" | "path" => {
    if (!includeDefaults) {
      if (isUnderPath(resolvedPath, userSkillsDir)) return "user";
      if (isUnderPath(resolvedPath, projectSkillsDir)) return "project";
    }
    return "path";
  };

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
    if (skill.filePath) {
      const raw = readFileSync(skill.filePath, "utf-8");
      const parsed = parseFrontmatter<SkillFrontmatter>(raw);
      frontmatter = parsed.frontmatter;
    }

    return {
      skill,
      frontmatter,
      metadata: resolveSkillMetadata(frontmatter),
      invocation: resolveSkillInvocationPolicy(frontmatter),
    };
  });
}
