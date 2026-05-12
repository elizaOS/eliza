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

// Bundle-safety: force binding identities into the module's init
// function so Bun.build's tree-shake doesn't collapse this barrel
// into an empty `init_X = () => {}`. Without this the on-device
// mobile agent explodes with `ReferenceError: <name> is not defined`
// when a consumer dereferences a re-exported binding at runtime.
import { useSkillAction as _bs_1_useSkillAction } from "./actions/use-skill";
import { estimateTokens as _bs_2_estimateTokens, extractBody as _bs_3_extractBody, generateSkillsJson as _bs_4_generateSkillsJson, parseFrontmatter as _bs_5_parseFrontmatter, validateFrontmatter as _bs_6_validateFrontmatter, validateSkillDirectory as _bs_7_validateSkillDirectory } from "./parser";
import { agentSkillsPlugin as _bs_8_agentSkillsPlugin, default as _bs_9_default } from "./plugin";
import { enabledSkillsProvider as _bs_10_enabledSkillsProvider } from "./providers/enabled-skills";
import { catalogAwarenessProvider as _bs_11_catalogAwarenessProvider, skillInstructionsProvider as _bs_12_skillInstructionsProvider, skillsSummaryProvider as _bs_13_skillsSummaryProvider } from "./providers/skills";
import { findBestInstallOption as _bs_14_findBestInstallOption, getAvailableInstallOptions as _bs_15_getAvailableInstallOptions, getInstallPlan as _bs_16_getInstallPlan, getPreferredNodeManager as _bs_17_getPreferredNodeManager, installSkillDependencies as _bs_18_installSkillDependencies, installSkillDependency as _bs_19_installSkillDependency, isAptAvailable as _bs_20_isAptAvailable, isCargoAvailable as _bs_21_isCargoAvailable, isHomebrewAvailable as _bs_22_isHomebrewAvailable, isPipAvailable as _bs_23_isPipAvailable } from "./services/install";
import { AgentSkillsService as _bs_24_AgentSkillsService } from "./services/skills";
import { createStorage as _bs_25_createStorage, FileSystemSkillStore as _bs_26_FileSystemSkillStore, loadSkillFromStorage as _bs_27_loadSkillFromStorage, MemorySkillStore as _bs_28_MemorySkillStore } from "./storage";
import { startSyncTask as _bs_29_startSyncTask, syncCatalogTask as _bs_30_syncCatalogTask } from "./tasks/sync-catalog";
import { SKILL_BODY_RECOMMENDED_TOKENS as _bs_31_SKILL_BODY_RECOMMENDED_TOKENS, SKILL_COMPATIBILITY_MAX_LENGTH as _bs_32_SKILL_COMPATIBILITY_MAX_LENGTH, SKILL_DESCRIPTION_MAX_LENGTH as _bs_33_SKILL_DESCRIPTION_MAX_LENGTH, SKILL_NAME_MAX_LENGTH as _bs_34_SKILL_NAME_MAX_LENGTH, SKILL_NAME_PATTERN as _bs_35_SKILL_NAME_PATTERN, SKILL_SOURCE_PRECEDENCE as _bs_36_SKILL_SOURCE_PRECEDENCE } from "./types";

// Path-derived symbol so parents that `export *` two of these don't
// collide on a shared `__BUNDLE_SAFETY__` name.
const __bundle_safety_PLUGINS_PLUGIN_AGENT_SKILLS_SRC_INDEX__ = [_bs_1_useSkillAction, _bs_2_estimateTokens, _bs_3_extractBody, _bs_4_generateSkillsJson, _bs_5_parseFrontmatter, _bs_6_validateFrontmatter, _bs_7_validateSkillDirectory, _bs_8_agentSkillsPlugin, _bs_9_default, _bs_10_enabledSkillsProvider, _bs_11_catalogAwarenessProvider, _bs_12_skillInstructionsProvider, _bs_13_skillsSummaryProvider, _bs_14_findBestInstallOption, _bs_15_getAvailableInstallOptions, _bs_16_getInstallPlan, _bs_17_getPreferredNodeManager, _bs_18_installSkillDependencies, _bs_19_installSkillDependency, _bs_20_isAptAvailable, _bs_21_isCargoAvailable, _bs_22_isHomebrewAvailable, _bs_23_isPipAvailable, _bs_24_AgentSkillsService, _bs_25_createStorage, _bs_26_FileSystemSkillStore, _bs_27_loadSkillFromStorage, _bs_28_MemorySkillStore, _bs_29_startSyncTask, _bs_30_syncCatalogTask, _bs_31_SKILL_BODY_RECOMMENDED_TOKENS, _bs_32_SKILL_COMPATIBILITY_MAX_LENGTH, _bs_33_SKILL_DESCRIPTION_MAX_LENGTH, _bs_34_SKILL_NAME_MAX_LENGTH, _bs_35_SKILL_NAME_PATTERN, _bs_36_SKILL_SOURCE_PRECEDENCE];
(globalThis as Record<string, unknown>).__bundle_safety_PLUGINS_PLUGIN_AGENT_SKILLS_SRC_INDEX__ = __bundle_safety_PLUGINS_PLUGIN_AGENT_SKILLS_SRC_INDEX__;
