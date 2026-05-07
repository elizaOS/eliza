/**
 * Provenance of a skill — distinguishes human-authored from agent-derived
 * skills, and tracks self-improvement signal across the closed learning loop.
 */
export interface SkillProvenance {
  /** Whether the skill was authored by a human or derived by the agent. */
  source: "human" | "agent-generated" | "agent-refined";
  /** Trajectory that produced or last refined the skill, if any. */
  derivedFromTrajectory?: string;
  /** ISO8601 timestamp when this provenance entry was recorded. */
  createdAt: string;
  /** Number of times the agent has automatically refined this skill. */
  refinedCount: number;
  /** Most recent eval score from the scoring cron, in [0, 1]. */
  lastEvalScore?: number;
  /**
   * Audit trail for native-optimizer-driven skill refinements.
   *
   * Populated by the gradient-mode branch of `skillRefinementEvaluator` —
   * after the LLM-diff auto-budget is exhausted, the evaluator switches to
   * the native `prompt-evolution` optimizer and appends one entry per run.
   */
  optimizationLineage?: Array<{
    optimizer: "instruction-search" | "prompt-evolution" | "bootstrap-fewshot";
    score: number;
    datasetSize: number;
    generatedAt: string;
  }>;
}

/**
 * Skill frontmatter parsed from SKILL.md YAML header
 */
export interface SkillFrontmatter {
  /** Skill name (should match parent directory name) */
  name?: string;
  /** Human-readable description of what the skill does */
  description?: string;
  /** If true, skill won't be included in model prompts (command-only) */
  "disable-model-invocation"?: boolean;
  /** Required operating systems (e.g., ["macos", "linux"]) */
  "required-os"?: string[];
  /** Required binaries that must be available in PATH */
  "required-bins"?: string[];
  /** Required environment variables */
  "required-env"?: string[];
  /** Primary environment for the skill (e.g., "node", "python") */
  "primary-env"?: string;
  /** Command dispatch mode */
  "command-dispatch"?: string;
  /** Command dispatch mode (underscore variant) */
  command_dispatch?: string;
  /** Tool name for command dispatch */
  "command-tool"?: string;
  /** Tool name for command dispatch (underscore variant) */
  command_tool?: string;
  /** Argument mode for command dispatch */
  "command-arg-mode"?: string;
  /** Whether skill can be invoked by users via commands */
  "user-invocable"?: boolean;
  /** Provenance metadata — present on agent-derived/curated skills. */
  provenance?: SkillProvenance;
  /** Additional arbitrary metadata */
  [key: string]: unknown;
}

/**
 * Loaded skill with parsed metadata.
 *
 * Core fields (filePath, baseDir, source, disableModelInvocation) are for file-based skills.
 * Optional runtime fields (instructions, actions, providers, tools, etc.) support inline definitions.
 */
export interface Skill {
  /** Skill name (from frontmatter or directory name) */
  name: string;
  /** Human-readable description */
  description: string;
  /** Absolute path to the SKILL.md file (optional for inline skills) */
  filePath?: string;
  /** Absolute path to the skill's base directory (optional for inline skills) */
  baseDir?: string;
  /** Source identifier (e.g., "bundled", "workspace", "managed", "inline", "curated") */
  source?: string;
  /** If true, skill won't be included in model prompts */
  disableModelInvocation?: boolean;
  /**
   * Provenance metadata when the skill was derived from a trajectory or
   * user-authored as a "curated" skill. Optional for backward compatibility:
   * existing on-disk skills with no provenance block are treated as `human`.
   */
  provenance?: SkillProvenance;

  // Runtime definition fields (for inline/programmatic skills)
  /** Unique slug identifier for the skill */
  slug?: string;
  /** Skill version */
  version?: string;
  /** Skill instructions/content */
  instructions?: string;
  /** System prompt for the skill */
  systemPrompt?: string;
  /** Example usages */
  examples?: string[];
  /** Whether the skill is enabled */
  enabled?: boolean;
  /** Actions the skill provides */
  actions?: SkillActionDefinition[];
  /** Providers the skill provides */
  providers?: SkillProviderDefinition[];
  /** Tools available to the skill */
  tools?: SkillToolDefinition[];
}

/**
 * Skill action definition for inline skills
 */
export interface SkillActionDefinition {
  name: string;
  description: string;
  handler: string;
}

/**
 * Skill provider definition for inline skills
 */
export interface SkillProviderDefinition {
  name: string;
  description: string;
  get: string;
}

/**
 * Skill tool definition for inline skills (generic, specific implementations can extend)
 */
export interface SkillToolDefinition {
  name: string;
  description?: string;
  [key: string]: unknown;
}

/**
 * Diagnostic information from skill loading
 */
export interface SkillDiagnostic {
  /** Diagnostic type */
  type: "warning" | "error" | "collision";
  /** Human-readable message */
  message: string;
  /** Path to the file that generated this diagnostic */
  path: string;
  /** Collision details (only for type="collision") */
  collision?: {
    resourceType: "skill";
    name: string;
    winnerPath: string;
    loserPath: string;
  };
}

/**
 * Result from loading skills from a directory
 */
export interface LoadSkillsResult {
  /** Successfully loaded skills */
  skills: Skill[];
  /** Diagnostics from loading process */
  diagnostics: SkillDiagnostic[];
}

/**
 * Options for loadSkillsFromDir
 */
export interface LoadSkillsFromDirOptions {
  /** Directory to scan for skills */
  dir: string;
  /** Source identifier for these skills */
  source: string;
}

/**
 * Options for loadSkills (multi-directory loading)
 */
export interface LoadSkillsOptions {
  /** Working directory for project-local skills. Default: process.cwd() */
  cwd?: string;
  /** Agent config directory for global skills */
  agentDir?: string;
  /** Explicit skill paths (files or directories) */
  skillPaths?: string[];
  /** Include default skills directories. Default: true */
  includeDefaults?: boolean;
  /** Path to bundled skills directory. Default: package's skills/ */
  bundledSkillsDir?: string;
  /** Path to managed skills directory. Default: ~/.elizaos/skills */
  managedSkillsDir?: string;
}

/**
 * Parsed skill entry with frontmatter and metadata
 */
export interface SkillEntry {
  /** The loaded skill */
  skill: Skill;
  /** Raw parsed frontmatter */
  frontmatter: SkillFrontmatter;
  /** Resolved skill metadata */
  metadata: SkillMetadata;
  /** Invocation policy */
  invocation: SkillInvocationPolicy;
}

/**
 * Skill runtime metadata
 */
export interface SkillMetadata {
  /** Primary environment (node, python, etc.) */
  primaryEnv?: string;
  /** Required operating systems */
  requiredOs?: string[];
  /** Required binaries */
  requiredBins?: string[];
  /** Required environment variables */
  requiredEnv?: string[];
}

/**
 * Skill invocation policy
 */
export interface SkillInvocationPolicy {
  /** If true, skill won't be included in model prompts */
  disableModelInvocation?: boolean;
  /** If false, skill cannot be invoked via user commands */
  userInvocable?: boolean;
}

/**
 * Skill command specification for chat commands
 */
export interface SkillCommandSpec {
  /** Command name (sanitized, unique) */
  name: string;
  /** Original skill name */
  skillName: string;
  /** Command description */
  description: string;
  /** Optional dispatch configuration */
  dispatch?: {
    kind: "tool";
    toolName: string;
    argMode: "raw";
  };
}
