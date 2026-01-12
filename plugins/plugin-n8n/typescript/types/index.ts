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
  parameters?: Record<string, string>;
}

export interface ProviderSpecification {
  name: string;
  description: string;
  dataStructure?: Record<string, string>;
}

export interface ServiceSpecification {
  name: string;
  description: string;
  methods?: string[];
}

export interface EvaluatorSpecification {
  name: string;
  description: string;
  triggers?: string[];
}

export interface EnvironmentVariableSpec {
  name: string;
  description: string;
  required: boolean;
  sensitive: boolean;
}

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
export type JobStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

/**
 * Error that occurred during plugin creation.
 */
export interface JobError {
  iteration: number;
  phase: string;
  error: string;
  timestamp: Date;
}

export interface TestResults {
  passed: number;
  failed: number;
  duration: number;
}

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

export interface CreatePluginOptions {
  useTemplate?: boolean;
  model?: ClaudeModel;
}

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
