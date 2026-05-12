/**
 * Agent Skills Types
 *
 * Implements the Agent Skills specification from agentskills.io
 * with Otto compatibility extensions.
 *
 * @see https://agentskills.io/specification
 */

// ============================================================
// CORE SKILL TYPES (Agent Skills Specification)
// ============================================================

/**
 * Skill frontmatter as defined by the Agent Skills specification.
 *
 * Required fields: name, description
 * Optional fields: license, compatibility, metadata, allowed-tools
 */
export interface SkillFrontmatter {
	/** Skill name (1-64 chars, lowercase alphanumeric + hyphens) */
	name: string;

	/** What the skill does and when to use it (1-1024 chars) */
	description: string;

	/** License name or reference to bundled license file */
	license?: string;

	/** Environment requirements (max 500 chars) */
	compatibility?: string;

	/** Arbitrary key-value mapping for additional metadata */
	metadata?: SkillMetadata;

	/** Space-delimited list of pre-approved tools (experimental) */
	"allowed-tools"?: string;

	/** Homepage URL (Otto extension) */
	homepage?: string;
}

/**
 * Skill metadata - arbitrary key-value mapping.
 * Includes Otto-specific extensions.
 */
export interface SkillMetadata {
	/** Skill author */
	author?: string;

	/** Skill version */
	version?: string;

	/** Otto-specific metadata */
	otto?: OttoMetadata;

	/** Additional arbitrary fields */
	[key: string]: string | number | boolean | object | undefined;
}

/**
 * Skill requirements specification.
 * Used to determine skill eligibility based on system capabilities.
 */
export interface SkillRequirements {
	/** Required binaries that must be in PATH */
	bins?: string[];
	/** Required environment variables that must be set */
	env?: string[];
	/** Required configuration keys that must be present */
	config?: string[];
}

/**
 * Otto-specific metadata extensions.
 * Used for dependency management and installation.
 */
export interface OttoMetadata {
	/** Emoji icon for the skill */
	emoji?: string;

	/** Required binaries/dependencies/env vars */
	requires?: SkillRequirements;

	/** Installation instructions */
	install?: OttoInstallOption[];

	/** Category for grouping skills */
	category?: string;

	/** Tags for skill discovery */
	tags?: string[];
}

/**
 * Otto installation option.
 * Defines how to install required dependencies.
 */
export interface OttoInstallOption {
	/** Unique identifier for this install option */
	id: string;

	/** Installation method kind */
	kind: "brew" | "apt" | "node" | "pip" | "cargo" | "manual";

	/** Package name (for brew, apt, pip, cargo) */
	formula?: string;
	package?: string;

	/** Binary names provided by this installation */
	bins?: string[];

	/** Human-readable label */
	label?: string;
}

// ============================================================
// LOADED SKILL TYPES
// ============================================================

/**
 * A fully loaded skill with parsed content.
 */
export interface Skill {
	/** Skill slug (directory name, matches frontmatter name) */
	slug: string;

	/** Display name from frontmatter */
	name: string;

	/** Description from frontmatter */
	description: string;

	/** Skill version (from metadata or lockfile) */
	version: string;

	/** Full SKILL.md content (including frontmatter) */
	content: string;

	/** Parsed frontmatter */
	frontmatter: SkillFrontmatter;

	/** Absolute path to skill directory */
	path: string;

	/** List of script files in scripts/ directory */
	scripts: string[];

	/** List of reference files in references/ directory */
	references: string[];

	/** List of asset files in assets/ directory */
	assets: string[];

	/** When the skill was loaded */
	loadedAt: number;
}

/**
 * Extended Skill type with source tracking.
 * Used to distinguish bundled (read-only) vs managed (modifiable) skills.
 */
export interface LoadedSkill extends Skill {
	/** Source of the skill: 'bundled' (read-only) or 'managed' (installed/modifiable) */
	source: "bundled" | "managed";

	/** For bundled skills, the directory they were loaded from */
	bundledDir?: string;
}

/**
 * Skill metadata for progressive disclosure (Level 1).
 * Only loaded at startup - minimal context usage.
 */
export interface SkillMetadataEntry {
	/** Skill name */
	name: string;

	/** Skill description */
	description: string;

	/** Path to SKILL.md */
	location: string;
}

/**
 * Skill instructions (Level 2) - the body of SKILL.md without frontmatter.
 */
export interface SkillInstructions {
	/** Skill slug */
	slug: string;

	/** Instructions body (markdown) */
	body: string;

	/** Recommended token estimate */
	estimatedTokens: number;
}

// ============================================================
// REGISTRY TYPES (ClawHub Integration)
// ============================================================

/**
 * Search result from ClawHub registry.
 */
export interface SkillSearchResult {
	/** Relevance score (0-1) */
	score: number;

	/** Skill slug */
	slug: string;

	/** Display name */
	displayName: string;

	/** Short summary */
	summary: string;

	/** Latest version */
	version: string;

	/** Last update timestamp */
	updatedAt: number;
}

/**
 * Catalog entry from ClawHub registry.
 */
export interface SkillCatalogEntry {
	/** Skill slug */
	slug: string;

	/** Display name */
	displayName: string;

	/** Short summary */
	summary: string | null;

	/** Latest version */
	version: string;

	/** Tags/categories */
	tags: Record<string, string>;

	/** Usage statistics */
	stats: {
		downloads: number;
		stars: number;
	};

	/** Last update timestamp */
	updatedAt: number;
}

/**
 * Detailed skill information from ClawHub registry.
 */
export interface SkillDetails {
	skill: {
		slug: string;
		displayName: string;
		summary: string;
		tags: Record<string, string>;
		stats: { downloads: number; stars: number; versions: number };
		createdAt: number;
		updatedAt: number;
	};
	latestVersion: { version: string; createdAt: number; changelog?: string };
	owner?: { handle: string; displayName: string; image?: string };
}

// ============================================================
// VALIDATION TYPES
// ============================================================

/**
 * Skill validation result.
 */
export interface SkillValidationResult {
	valid: boolean;
	errors: SkillValidationError[];
	warnings: SkillValidationWarning[];
}

export interface SkillValidationError {
	field: string;
	message: string;
	code: string;
}

export interface SkillValidationWarning {
	field: string;
	message: string;
	code: string;
}

// ============================================================
// SERVICE TYPES
// ============================================================

/**
 * Cache options for service methods.
 */
export interface CacheOptions {
	/** Max age in milliseconds, undefined = use default TTL */
	notOlderThan?: number;

	/** Bypass cache entirely */
	forceRefresh?: boolean;
}

/**
 * Skill loading options.
 */
export interface LoadSkillOptions {
	/** Whether to validate the skill */
	validate?: boolean;

	/** Whether to load scripts list */
	loadScripts?: boolean;

	/** Whether to load references list */
	loadReferences?: boolean;

	/** Whether to load assets list */
	loadAssets?: boolean;
}

/**
 * Skill installation options.
 */
export interface InstallSkillOptions {
	/** Specific version to install */
	version?: string;

	/** Force reinstall even if already installed */
	force?: boolean;
}

// ============================================================
// PROMPT GENERATION TYPES
// ============================================================

/** Options for generating skill metadata JSON for prompts. */
export interface PromptJsonOptions {
	/** Include location paths */
	includeLocation?: boolean;

	/** Maximum number of skills to include */
	maxSkills?: number;
}

// ============================================================
// CONSTANTS
// ============================================================

/** Maximum length for skill name */
export const SKILL_NAME_MAX_LENGTH = 64;

/** Maximum length for skill description */
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

/** Maximum length for compatibility field */
export const SKILL_COMPATIBILITY_MAX_LENGTH = 500;

/** Recommended maximum body length (tokens) */
export const SKILL_BODY_RECOMMENDED_TOKENS = 5000;

/** Pattern for valid skill names */
export const SKILL_NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

// ============================================================
// ELIGIBILITY TYPES
// ============================================================

/**
 * Reason why a skill is ineligible.
 */
export interface IneligibilityReason {
	/** Type of requirement that failed */
	type: "bin" | "env" | "config";
	/** The specific item that is missing */
	missing: string;
	/** Human-readable message */
	message: string;
	/** Suggested fix if available */
	suggestion?: string;
}

/**
 * Skill eligibility status.
 */
export interface SkillEligibility {
	/** Skill slug */
	slug: string;
	/** Whether the skill is eligible for use */
	eligible: boolean;
	/** Reasons for ineligibility */
	reasons: IneligibilityReason[];
	/** When eligibility was last checked */
	checkedAt: number;
	/** Available installation options to fix eligibility */
	installOptions?: OttoInstallOption[];
}

/**
 * Extended LoadedSkill type with eligibility information.
 */
export interface EligibleSkill extends LoadedSkill {
	/** Eligibility status */
	eligibility: SkillEligibility;
}

// ============================================================
// CONFIGURATION TYPES
// ============================================================

/**
 * Per-skill environment configuration.
 */
export interface SkillEnvConfig {
	/** Environment variables to inject when running this skill */
	[key: string]: string;
}

/**
 * Per-skill configuration entry.
 */
export interface SkillConfigEntry {
	/** Per-skill environment variables */
	env?: SkillEnvConfig;
	/** API key for the skill (stored securely) */
	apiKey?: string;
	/** Whether the skill is enabled (default: true) */
	enabled?: boolean;
	/** Custom configuration options */
	options?: Record<string, string | number | boolean>;
}

/**
 * Skills service configuration.
 */
export interface SkillsServiceConfig {
	/** Storage type: 'memory', 'filesystem', or 'auto' (default) */
	storageType?: "memory" | "filesystem" | "auto";

	/** Base path for managed skill storage */
	skillsDir?: string;

	/** Workspace skills directory (highest precedence) */
	workspaceSkillsDir?: string;

	/** Plugin-contributed skills directories */
	pluginSkillsDirs?: string[];

	/** Extra directories to load skills from (lowest precedence) */
	extraDirs?: string[];

	/** Bundled skills directories (read-only) */
	bundledSkillsDirs?: string[];

	/** Registry API URL */
	registryUrl?: string;

	/** Sync the remote skill catalog during service initialization */
	syncCatalogOnStart?: boolean;

	/** Auto-load installed skills on init */
	autoLoad?: boolean;

	/** Custom storage instance (overrides storageType/skillsDir) */
	storage?: import("./storage").ISkillStorage;

	/** Allowlist of skill slugs (only these skills will be loaded) */
	allowlist?: string[];

	/** Denylist of skill slugs (these skills will not be loaded) */
	denylist?: string[];

	/** Per-skill configuration */
	skillEntries?: Record<string, SkillConfigEntry>;

	/** Enable filesystem watcher for auto-refresh */
	autoRefresh?: boolean;

	/** Auto-refresh interval in milliseconds (default: 5000) */
	autoRefreshInterval?: number;
}

// ============================================================
// INSTALL PROGRESS TYPES
// ============================================================

/**
 * Installation progress event.
 */
export interface InstallProgressEvent {
	/** Current phase of installation */
	phase:
		| "downloading"
		| "extracting"
		| "installing"
		| "verifying"
		| "complete"
		| "error";
	/** Progress percentage (0-100) if known */
	progress?: number;
	/** Human-readable message */
	message: string;
	/** Error details if phase is 'error' */
	error?: string;
}

/**
 * Callback for installation progress updates.
 */
export type InstallProgressCallback = (event: InstallProgressEvent) => void;

/**
 * Options for skill dependency installation.
 */
export interface InstallDependencyOptions {
	/** The install option to use */
	option: OttoInstallOption;
	/** Progress callback */
	onProgress?: InstallProgressCallback;
	/** Whether to run in dry-run mode */
	dryRun?: boolean;
	/** Timeout in milliseconds (default: 300000 - 5 minutes) */
	timeout?: number;
}

/**
 * Result of a dependency installation attempt.
 */
export interface InstallDependencyResult {
	/** Whether installation succeeded */
	success: boolean;
	/** The install option that was used */
	option: OttoInstallOption;
	/** Error message if failed */
	error?: string;
	/** Time taken in milliseconds */
	duration?: number;
	/** Command that was executed */
	command?: string;
}

// ============================================================
// SKILL SOURCE TYPES
// ============================================================

/**
 * Skill source with precedence ordering.
 * Higher number = higher precedence.
 */
export type SkillSource =
	| "workspace" // 5 - highest precedence
	| "managed" // 4
	| "bundled" // 3
	| "plugin" // 2
	| "extra"; // 1 - lowest precedence

/**
 * Source precedence values for ordering.
 */
export const SKILL_SOURCE_PRECEDENCE: Record<SkillSource, number> = {
	workspace: 5,
	managed: 4,
	bundled: 3,
	plugin: 2,
	extra: 1,
};

/**
 * Extended LoadedSkill type with full source information.
 */
export interface LoadedSkillWithSource extends Skill {
	/** Source type of the skill */
	source: SkillSource;
	/** Source directory path */
	sourceDir: string;
	/** Precedence value (higher = higher priority) */
	precedence: number;
	/** Whether this skill overrides another */
	overrides?: string;
	/** Directory path for bundled skills (only set when source is "bundled") */
	bundledDir?: string;
}
