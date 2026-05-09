import type { Skill, SkillCommandSpec, SkillEntry } from "./types.js";

/**
 * Compact a skill field for prompt-friendly structured text.
 *
 * @param str - String to compact
 * @returns Single-line prompt field
 */
function compactPromptField(str: string): string {
  return str.replace(/\s+/g, " ").trim();
}

/**
 * Format skills for inclusion in a system prompt.
 * Uses compact structured text.
 *
 * Skills with disableModelInvocation=true are excluded from the prompt
 * (they can only be invoked explicitly via /skill:name commands).
 *
 * @param skills - Array of skills to format
 * @returns Formatted skills prompt section
 */
export function formatSkillsForPrompt(skills: Skill[]): string {
  const visibleSkills = skills.filter((s) => !s.disableModelInvocation);

  if (visibleSkills.length === 0) {
    return "";
  }

  const lines = [
    "\n\nThe following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
    "",
    "available_skills:",
  ];

  for (const skill of visibleSkills) {
    lines.push(`- name: ${compactPromptField(skill.name)}`);
    lines.push(`  description: ${compactPromptField(skill.description)}`);
    if (skill.filePath) {
      lines.push(`  location: ${compactPromptField(skill.filePath)}`);
    }
  }

  return lines.join("\n");
}

/**
 * Format skill entries for prompt (filters by invocation policy)
 *
 * @param entries - Skill entries to format
 * @returns Formatted skills prompt section
 */
export function formatSkillEntriesForPrompt(entries: SkillEntry[]): string {
  const visibleSkills = entries
    .filter((entry) => entry.invocation?.disableModelInvocation !== true)
    .map((entry) => entry.skill);

  return formatSkillsForPrompt(visibleSkills);
}

/** Maximum length for skill command names */
const SKILL_COMMAND_MAX_LENGTH = 32;

/** Fallback command name if sanitization produces empty string */
const SKILL_COMMAND_FALLBACK = "skill";

/** Maximum length for command descriptions (Discord limit) */
const SKILL_COMMAND_DESCRIPTION_MAX_LENGTH = 100;

/**
 * Sanitize a skill name for use as a command name.
 * Converts to lowercase, replaces invalid characters with underscores.
 *
 * @param raw - Raw skill name
 * @returns Sanitized command name
 */
function sanitizeSkillCommandName(raw: string): string {
  const clamped = raw.length > 1024 ? raw.slice(0, 1024) : raw;
  const normalized = clamped
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const trimmed = normalized.slice(0, SKILL_COMMAND_MAX_LENGTH);
  return trimmed || SKILL_COMMAND_FALLBACK;
}

/**
 * Resolve a unique command name by appending a numeric suffix if needed.
 *
 * @param base - Base command name
 * @param used - Set of already-used command names (lowercase)
 * @returns Unique command name
 */
function resolveUniqueSkillCommandName(
  base: string,
  used: Set<string>,
): string {
  const normalizedBase = base.toLowerCase();
  if (!used.has(normalizedBase)) {
    return base;
  }
  for (let index = 2; index < 1000; index += 1) {
    const suffix = `_${index}`;
    const maxBaseLength = Math.max(1, SKILL_COMMAND_MAX_LENGTH - suffix.length);
    const trimmedBase = base.slice(0, maxBaseLength);
    const candidate = `${trimmedBase}${suffix}`;
    const candidateKey = candidate.toLowerCase();
    if (!used.has(candidateKey)) {
      return candidate;
    }
  }
  const fallback = `${base.slice(0, Math.max(1, SKILL_COMMAND_MAX_LENGTH - 2))}_x`;
  return fallback;
}

/**
 * Build command specifications from skill entries.
 * Creates sanitized, unique command names for each user-invocable skill.
 *
 * @param entries - Skill entries to process
 * @param reservedNames - Set of reserved command names to avoid
 * @returns Array of skill command specifications
 */
export function buildSkillCommandSpecs(
  entries: SkillEntry[],
  reservedNames?: Set<string>,
): SkillCommandSpec[] {
  // Filter to user-invocable skills
  const userInvocable = entries.filter(
    (entry) => entry.invocation?.userInvocable !== false,
  );

  const used = new Set<string>();
  for (const reserved of reservedNames ?? []) {
    used.add(reserved.toLowerCase());
  }

  const specs: SkillCommandSpec[] = [];

  for (const entry of userInvocable) {
    const rawName = entry.skill.name;
    const base = sanitizeSkillCommandName(rawName);
    const unique = resolveUniqueSkillCommandName(base, used);
    used.add(unique.toLowerCase());

    const rawDescription = entry.skill.description?.trim() || rawName;
    const description =
      rawDescription.length > SKILL_COMMAND_DESCRIPTION_MAX_LENGTH
        ? `${rawDescription.slice(0, SKILL_COMMAND_DESCRIPTION_MAX_LENGTH - 1)}…`
        : rawDescription;

    // Parse dispatch configuration from frontmatter
    const dispatch = (() => {
      const kindRaw = (
        entry.frontmatter?.["command-dispatch"] ??
        entry.frontmatter?.command_dispatch ??
        ""
      )
        .toString()
        .trim()
        .toLowerCase();

      if (!kindRaw || kindRaw !== "tool") {
        return undefined;
      }

      const toolName = (
        entry.frontmatter?.["command-tool"] ??
        entry.frontmatter?.command_tool ??
        ""
      )
        .toString()
        .trim();

      if (!toolName) {
        return undefined;
      }

      return { kind: "tool" as const, toolName, argMode: "raw" as const };
    })();

    specs.push({
      name: unique,
      skillName: rawName,
      description,
      ...(dispatch ? { dispatch } : {}),
    });
  }

  return specs;
}

/**
 * Format a single skill for display (minimal format)
 *
 * @param skill - Skill to format
 * @returns Formatted skill string
 */
export function formatSkillSummary(skill: Skill): string {
  return `${skill.name}: ${skill.description}`;
}

/**
 * Format skills as a simple list
 *
 * @param skills - Skills to format
 * @returns Newline-separated list of skills
 */
export function formatSkillsList(skills: Skill[]): string {
  return skills.map(formatSkillSummary).join("\n");
}
