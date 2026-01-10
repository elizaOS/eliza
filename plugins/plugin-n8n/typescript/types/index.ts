/**
 * Type definitions for the N8n Plugin.
 */

/**
 * Claude model identifiers.
 */
export const ClaudeModel = {
  SONNET_3_5: "claude-3-5-sonnet-20241022",
  OPUS_3: "claude-3-opus-20240229",
} as const;

export type ClaudeModel = (typeof ClaudeModel)[keyof typeof ClaudeModel];

/**
 * Specification for a plugin action.
 */
export interface ActionSpecification {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

/**
 * Specification for a plugin provider.
 */
export interface ProviderSpecification {
  name: string;
  description: string;
  dataStructure?: Record<string, unknown>;
}

/**
 * Specification for a plugin service.
 */
export interface ServiceSpecification {
  name: string;
  description: string;
  methods?: string[];
}

/**
 * Specification for a plugin evaluator.
 */
export interface EvaluatorSpecification {
  name: string;
  description: string;
  triggers?: string[];
}

/**
 * Environment variable specification.
 */
export interface EnvironmentVariableSpec {
  name: string;
  description: string;
  required: boolean;
  sensitive: boolean;
}

/**
 * Complete specification for creating a plugin.
 */
export interface PluginSpecification {
  name: string;
  description: string;
  version?: string;
  actions?: ActionSpecification[];
  providers?: ProviderSpecification[];
  services?: ServiceSpecification[];
  evaluators?: EvaluatorSpecification[];
  dependencies?: Record<string, string>;
  environmentVariables?: EnvironmentVariableSpec[];
}

/**
 * Status of a plugin creation job.
 */
export type JobStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

/**
 * Error that occurred during plugin creation.
 */
export interface JobError {
  iteration: number;
  phase: string;
  error: string;
  timestamp: Date;
}

/**
 * Test results from plugin validation.
 */
export interface TestResults {
  passed: number;
  failed: number;
  duration: number;
}

/**
 * A plugin creation job tracking object.
 */
export interface PluginCreationJob {
  id: string;
  specification: PluginSpecification;
  status: JobStatus;
  currentPhase: string;
  progress: number;
  logs: string[];
  error?: string;
  result?: string;
  outputPath: string;
  startedAt: Date;
  completedAt?: Date;
  currentIteration: number;
  maxIterations: number;
  testResults?: TestResults;
  validationScore?: number;
  errors: JobError[];
  modelUsed?: ClaudeModel;
}

/**
 * Options for creating a plugin.
 */
export interface CreatePluginOptions {
  useTemplate?: boolean;
  model?: ClaudeModel;
}

/**
 * Plugin registry data.
 */
export interface PluginRegistryData {
  totalCreated: number;
  plugins: Array<{
    name: string;
    id?: string;
    status?: JobStatus;
    phase?: string;
    progress?: number;
    startedAt?: Date;
    completedAt?: Date;
    modelUsed?: ClaudeModel;
  }>;
  activeJobs: number;
}

