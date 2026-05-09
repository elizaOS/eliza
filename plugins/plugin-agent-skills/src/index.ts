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

export { useSkillAction } from "./actions/use-skill";
// Parser utilities
export {
	estimateTokens,
	extractBody,
	generateSkillsJson,
	parseFrontmatter,
	validateFrontmatter,
	validateSkillDirectory,
} from "./parser";
export { agentSkillsPlugin, default } from "./plugin";
// Providers
export { enabledSkillsProvider } from "./providers/enabled-skills";
export {
	catalogAwarenessProvider,
	skillInstructionsProvider,
	skillsSummaryProvider,
} from "./providers/skills";
// Install service
export {
	findBestInstallOption,
	getAvailableInstallOptions,
	getInstallPlan,
	getPreferredNodeManager,
	installSkillDependencies,
	installSkillDependency,
	isAptAvailable,
	isCargoAvailable,
	isHomebrewAvailable,
	isPipAvailable,
} from "./services/install";
export type { AgentSkillsServiceConfig } from "./services/skills";
// Service
export { AgentSkillsService } from "./services/skills";
// Storage
export type { ISkillStorage, SkillFile, SkillPackage } from "./storage";
export {
	createStorage,
	FileSystemSkillStore,
	loadSkillFromStorage,
	MemorySkillStore,
} from "./storage";
// Tasks
export { startSyncTask, syncCatalogTask } from "./tasks/sync-catalog";
// Types
export type {
	// Options types
	CacheOptions,
	EligibleSkill,
	IneligibilityReason,
	InstallDependencyOptions,
	InstallDependencyResult,
	InstallProgressCallback,
	// Installation types
	InstallProgressEvent,
	InstallSkillOptions,
	LoadedSkill,
	LoadedSkillWithSource,
	LoadSkillOptions,
	OttoInstallOption,
	// Otto extensions
	OttoMetadata,
	PromptJsonOptions,
	// Core skill types
	Skill,
	SkillCatalogEntry,
	SkillConfigEntry,
	SkillDetails,
	// Eligibility types
	SkillEligibility,
	// Configuration types
	SkillEnvConfig,
	SkillFrontmatter,
	SkillInstructions,
	SkillMetadata,
	SkillMetadataEntry,
	SkillRequirements,
	// Registry types
	SkillSearchResult,
	// Source types
	SkillSource,
	SkillsServiceConfig,
	SkillValidationError,
	// Validation types
	SkillValidationResult,
	SkillValidationWarning,
} from "./types";
// Constants
export {
	SKILL_BODY_RECOMMENDED_TOKENS,
	SKILL_COMPATIBILITY_MAX_LENGTH,
	SKILL_DESCRIPTION_MAX_LENGTH,
	SKILL_NAME_MAX_LENGTH,
	SKILL_NAME_PATTERN,
	SKILL_SOURCE_PRECEDENCE,
} from "./types";
