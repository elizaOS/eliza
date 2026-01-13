/**
 * Type definitions for the run module
 */

import { AgentConfig } from '../agent/agents';
import { EnvironmentConfig } from '../environment/swe-env';
import { ProblemStatementConfig } from '../agent/problem-statement';
import { DeploymentConfig } from '../environment/deployment';

/**
 * Configuration for single run actions
 */
export interface RunSingleActionConfig {
  openPr: boolean;
  prConfig?: {
    skipIfCommitsReferenceIssue?: boolean;
    [key: string]: unknown;
  };
  applyPatchLocally: boolean;
}

/**
 * Configuration for running a single instance
 */
export interface RunSingleConfig {
  env: EnvironmentConfig;
  agent: AgentConfig;
  problemStatement: ProblemStatementConfig;
  outputDir: string;
  actions: RunSingleActionConfig;
  envVarPath?: string;
}

/**
 * Configuration for batch instances source
 */
export interface BatchInstanceSourceConfig {
  type?: 'file' | 'swe_bench' | 'huggingface';
  path?: string;
  filter?: string;
  slice?: string;
  shuffle?: boolean;
  deployment?: DeploymentConfig;
  subset?: 'lite' | 'verified' | 'full' | 'multimodal' | 'multilingual';
  split?: 'dev' | 'test';
  pathOverride?: string;
  evaluate?: boolean;
  dataset_name?: string;
}

/**
 * Configuration for running batch instances
 */
export interface RunBatchConfig {
  instances: BatchInstanceSourceConfig;
  agent: AgentConfig;
  outputDir: string;
  suffix?: string;
  raiseExceptions?: boolean;
  redoExisting?: boolean;
  envVarPath?: string;
  numWorkers?: number;
  randomDelayMultiplier?: number;
  progressBar?: boolean;
}

/**
 * Command line configuration
 */
export interface CLIConfig {
  config?: string;
  env?: EnvironmentConfig;
  agent?: AgentConfig;
  problemStatement?: ProblemStatementConfig;
  outputDir?: string;
  actions?: RunSingleActionConfig;
  instances?: BatchInstanceSourceConfig;
  numWorkers?: number;
  redoExisting?: boolean;
  randomDelayMultiplier?: number;
}

/**
 * Trajectory data structure
 */
export interface TrajectoryData {
  history?: Array<{ role: string; content: string; tool_calls?: unknown }>;
  replay_config?: string | RunSingleConfig;
  info?: { instance_id?: string; submission?: string; exitStatus?: string };
  environment?: Record<string, unknown>;
  problemStatement?: ProblemStatementConfig;
  trajectory?: Array<{
    action?: string;
    observation?: string;
    response?: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

/**
 * SWE-Bench instance data
 */
export interface SWEBenchInstanceData {
  instance_id: string;
  repo: string;
  version: string;
  base_commit: string;
  problem_statement: string;
  hints_text?: string;
  created_at?: string;
  test_patch?: string;
  [key: string]: unknown;
}

/**
 * Demo data structure for trajectory conversion
 */
export interface DemoStep {
  role: string;
  content: string;
  agent?: string;
  isDemo?: boolean;
}
