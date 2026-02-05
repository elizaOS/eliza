/**
 * @elizaos/skills - Bundled skills and skill loading utilities for elizaOS agents
 *
 * This package provides:
 * - Bundled skills (markdown files with instructions for specific tasks)
 * - Skill loading and discovery utilities
 * - Prompt formatting for LLM integration
 * - Command specification building for chat interfaces
 *
 * @example
 * ```typescript
 * import { getSkillsDir, loadSkills, formatSkillsForPrompt } from "@elizaos/skills";
 *
 * // Get path to bundled skills
 * const skillsPath = getSkillsDir();
 *
 * // Load all skills from default locations
 * const { skills, diagnostics } = loadSkills();
 *
 * // Format for LLM prompt
 * const prompt = formatSkillsForPrompt(skills);
 * ```
 */

// Types
export type {
	Skill,
	SkillFrontmatter,
	SkillDiagnostic,
	SkillEntry,
	SkillMetadata,
	SkillInvocationPolicy,
	SkillCommandSpec,
	LoadSkillsFromDirOptions,
	LoadSkillsOptions,
	LoadSkillsResult,
} from "./types.js";

// Path resolution
export { getSkillsDir, clearSkillsDirCache } from "./resolver.js";

// Skill loading
export { loadSkillsFromDir, loadSkills, loadSkillEntries } from "./loader.js";

// Frontmatter parsing
export {
	parseFrontmatter,
	stripFrontmatter,
	resolveSkillMetadata,
	resolveSkillInvocationPolicy,
	type ParsedFrontmatter,
} from "./frontmatter.js";

// Prompt formatting
export {
	formatSkillsForPrompt,
	formatSkillEntriesForPrompt,
	formatSkillSummary,
	formatSkillsList,
	buildSkillCommandSpecs,
} from "./formatter.js";
