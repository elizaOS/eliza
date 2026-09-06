/** Public loading, formatting and bundle-location contracts for skill consumers. */

export {
  buildSkillCommandSpecs,
  formatSkillEntriesForPrompt,
  formatSkillSummary,
  formatSkillsForPrompt,
  formatSkillsList,
} from "./formatter.js";
export {
  INVALID_SKILL_FRONTMATTER_YAML,
  type ParsedFrontmatter,
  parseFrontmatter,
  resolveSkillInvocationPolicy,
  resolveSkillMetadata,
  resolveSkillProvenance,
  serializeSkillFile,
  stripFrontmatter,
} from "./frontmatter.js";
export { loadSkillEntries, loadSkills, loadSkillsFromDir } from "./loader.js";
export {
  BUNDLED_SKILLS_OVERRIDE_INVALID,
  clearSkillsDirCache,
  getCuratedActiveDir,
  getProposedSkillsDir,
  getSkillsDir,
  promoteSkill,
} from "./resolver.js";
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
