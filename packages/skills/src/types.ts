export interface SkillProvenance {
  source: "human" | "agent-generated" | "agent-refined";
  derivedFromTrajectory?: string;
  createdAt: string;
  refinedCount: number;
  lastEvalScore?: number;
  optimizationLineage?: Array<{
    optimizer: "instruction-search" | "prompt-evolution" | "bootstrap-fewshot";
    score: number;
    datasetSize: number;
    generatedAt: string;
  }>;
}

export interface SkillFrontmatter {
  name?: string;
  description?: string;
  "disable-model-invocation"?: boolean;
  "required-os"?: string[];
  "required-bins"?: string[];
  "required-env"?: string[];
  "primary-env"?: string;
  "command-dispatch"?: string;
  command_dispatch?: string;
  "command-tool"?: string;
  command_tool?: string;
  "command-arg-mode"?: string;
  "user-invocable"?: boolean;
  provenance?: SkillProvenance;
  [key: string]: unknown;
}

export interface Skill {
  name: string;
  description: string;
  filePath?: string;
  baseDir?: string;
  source?: string;
  disableModelInvocation?: boolean;
  provenance?: SkillProvenance;

  slug?: string;
  version?: string;
  instructions?: string;
  systemPrompt?: string;
  examples?: string[];
  enabled?: boolean;
  actions?: SkillActionDefinition[];
  providers?: SkillProviderDefinition[];
  tools?: SkillToolDefinition[];
}

export interface SkillActionDefinition {
  name: string;
  description: string;
  handler: string;
}

export interface SkillProviderDefinition {
  name: string;
  description: string;
  get: string;
}

export interface SkillToolDefinition {
  name: string;
  description?: string;
  [key: string]: unknown;
}

export interface SkillDiagnostic {
  type: "warning" | "error" | "collision";
  message: string;
  path: string;
  collision?: {
    resourceType: "skill";
    name: string;
    winnerPath: string;
    loserPath: string;
  };
}

export interface LoadSkillsResult {
  skills: Skill[];
  diagnostics: SkillDiagnostic[];
}

export interface LoadSkillsFromDirOptions {
  dir: string;
  source: string;
}

export interface LoadSkillsOptions {
  cwd?: string;
  agentDir?: string;
  skillPaths?: string[];
  includeDefaults?: boolean;
  bundledSkillsDir?: string;
  managedSkillsDir?: string;
}

export interface SkillEntry {
  skill: Skill;
  frontmatter: SkillFrontmatter;
  metadata: SkillMetadata;
  invocation: SkillInvocationPolicy;
}

export interface SkillMetadata {
  primaryEnv?: string;
  requiredOs?: string[];
  requiredBins?: string[];
  requiredEnv?: string[];
}

export interface SkillInvocationPolicy {
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
}

export interface SkillCommandSpec {
  name: string;
  skillName: string;
  description: string;
  dispatch?: {
    kind: "tool";
    toolName: string;
    argMode: "raw";
  };
}
