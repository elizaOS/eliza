/**
 * Agent Skills Plugin for elizaOS
 *
 * Implements the Agent Skills specification with:
 * - Spec-compliant SKILL.md parsing and validation
 * - Progressive disclosure (metadata → instructions → resources)
 * - ClawHub registry integration
 * - Otto metadata compatibility
 * - Dual storage modes (memory/filesystem)
 *
 * @see https://agentskills.io
 */

export { agentSkillsPlugin, clawHubPlugin, default } from "./plugin";

// Types
export type {
  // Core skill types
  Skill,
  LoadedSkill,
  LoadedSkillWithSource,
  SkillFrontmatter,
  SkillMetadata,
  SkillMetadataEntry,
  SkillInstructions,
  // Otto extensions
  OttoMetadata,
  OttoInstallOption,
  SkillRequirements,
  // Registry types
  SkillSearchResult,
  SkillCatalogEntry,
  SkillDetails,
  // Validation types
  SkillValidationResult,
  SkillValidationError,
  SkillValidationWarning,
  // Options types
  CacheOptions,
  LoadSkillOptions,
  InstallSkillOptions,
  PromptXmlOptions,
  // Eligibility types
  SkillEligibility,
  IneligibilityReason,
  EligibleSkill,
  // Configuration types
  SkillEnvConfig,
  SkillConfigEntry,
  SkillsServiceConfig,
  // Installation types
  InstallProgressEvent,
  InstallProgressCallback,
  InstallDependencyOptions,
  InstallDependencyResult,
  // Source types
  SkillSource,
} from "./types";

// Constants
export {
  SKILL_NAME_MAX_LENGTH,
  SKILL_DESCRIPTION_MAX_LENGTH,
  SKILL_COMPATIBILITY_MAX_LENGTH,
  SKILL_BODY_RECOMMENDED_TOKENS,
  SKILL_NAME_PATTERN,
  SKILL_SOURCE_PRECEDENCE,
} from "./types";

// Service
export { AgentSkillsService, ClawHubService } from "./services/skills";
export type { AgentSkillsServiceConfig } from "./services/skills";

// Install service
export {
  installSkillDependency,
  installSkillDependencies,
  findBestInstallOption,
  getAvailableInstallOptions,
  getInstallPlan,
  getPreferredNodeManager,
  isHomebrewAvailable,
  isAptAvailable,
  isPipAvailable,
  isCargoAvailable,
} from "./services/install";

// Storage
export type { ISkillStorage, SkillFile, SkillPackage } from "./storage";
export {
  MemorySkillStore,
  FileSystemSkillStore,
  createStorage,
  loadSkillFromStorage,
} from "./storage";

// Parser utilities
export {
  parseFrontmatter,
  validateFrontmatter,
  validateSkillDirectory,
  extractBody,
  estimateTokens,
  generateSkillsXml,
} from "./parser";

// Actions
export { searchSkillsAction } from "./actions/search-skills";
export { getSkillDetailsAction } from "./actions/get-skill-details";
export { getSkillGuidanceAction } from "./actions/get-skill-guidance";
export { syncCatalogAction } from "./actions/sync-catalog";
export { runSkillScriptAction } from "./actions/run-skill-script";

// Providers
export {
  skillsOverviewProvider,
  skillsSummaryProvider,
  skillInstructionsProvider,
  catalogAwarenessProvider,
  skillsProvider,
} from "./providers/skills";

// Tasks
export { syncCatalogTask, startSyncTask } from "./tasks/sync-catalog";
