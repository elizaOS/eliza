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

// Prompt formatting
export {
  buildSkillCommandSpecs,
  formatSkillEntriesForPrompt,
  formatSkillSummary,
  formatSkillsForPrompt,
  formatSkillsList,
} from "./formatter.js";
// Frontmatter parsing
export {
  type ParsedFrontmatter,
  parseFrontmatter,
  resolveSkillInvocationPolicy,
  resolveSkillMetadata,
  resolveSkillProvenance,
  serializeSkillFile,
  stripFrontmatter,
} from "./frontmatter.js";

// Skill loading
export { loadSkillEntries, loadSkills, loadSkillsFromDir } from "./loader.js";
// Path resolution
export {
  clearSkillsDirCache,
  getCuratedActiveDir,
  getProposedSkillsDir,
  getSkillsDir,
  promoteSkill,
} from "./resolver.js";
// Types
export type {
  LoadSkillsFromDirOptions,
  LoadSkillsOptions,
  LoadSkillsResult,
  Skill,
  SkillActionDefinition,
  SkillCommandSpec,
  SkillDiagnostic,
  SkillEntry,
  SkillFrontmatter,
  SkillInvocationPolicy,
  SkillMetadata,
  SkillProvenance,
  SkillProviderDefinition,
  SkillToolDefinition,
} from "./types.js";
