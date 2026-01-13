/**
 * Type definitions
 * Converted from sweagent/types.py
 */

// ============================================================================
// CORE TYPE DEFINITIONS (moved here to be available for interfaces below)
// ============================================================================

/**
 * Tool call structure for LLM function calling
 */
export interface ToolCall {
  id?: string;
  type?: 'function';
  function: {
    name: string;
    arguments: string | Record<string, unknown>;
  };
}

/**
 * Query object in step output
 */
export interface QueryObject {
  type?: string;
  content?: string;
  [key: string]: unknown;
}

/**
 * Thinking block structure
 */
export interface ThinkingBlock {
  type: 'thinking';
  content: string;
  startTime?: number;
  endTime?: number;
}

/**
 * Cache control configuration
 */
export interface CacheControl {
  type: 'ephemeral' | 'persistent';
  maxAge?: number;
  scope?: 'user' | 'global';
}

/**
 * Output from a single agent step
 */
export interface StepOutput {
  query: QueryObject[];
  thought: string;
  action: string;
  output: string;
  observation: string;
  executionTime: number;
  done: boolean;
  exitStatus?: number | string | null;
  submission?: string | null;
  state: Record<string, string>;
  toolCalls?: ToolCall[] | null;
  toolCallIds?: string[] | null;
  thinkingBlocks?: ThinkingBlock[] | null;
  extraInfo: Record<string, unknown>;

  toTemplateFormatDict(): Record<string, string | number | boolean | null | undefined>;
}

/**
 * Implementation of StepOutput
 */
export class StepOutputImpl implements StepOutput {
  query: QueryObject[] = [{}];
  thought: string = '';
  action: string = '';
  output: string = '';
  observation: string = '';
  executionTime: number = 0.0;
  done: boolean = false;
  exitStatus?: number | string | null = null;
  submission?: string | null = null;
  state: Record<string, string> = {};
  toolCalls?: ToolCall[] | null = null;
  toolCallIds?: string[] | null = null;
  thinkingBlocks?: ThinkingBlock[] | null = null;
  extraInfo: Record<string, unknown> = {};

  toTemplateFormatDict(): Record<string, string | number | boolean | null | undefined> {
    return {
      thought: this.thought,
      action: this.action,
      output: this.output,
      observation: this.observation,
      executionTime: this.executionTime,
      done: this.done,
      exitStatus: this.exitStatus,
      submission: this.submission,
    };
  }
}

/**
 * A single step in the agent's trajectory
 */
export interface TrajectoryStep {
  action: string;
  observation: string;
  response: string;
  state: Record<string, string>;
  thought: string;
  executionTime: number;
  query: QueryObject[];
  extraInfo: Record<string, unknown>;
}

/**
 * Complete trajectory (array of steps)
 */
export type Trajectory = TrajectoryStep[];

/**
 * Base history item interface
 */
interface BaseHistoryItem {
  role: string;
  content: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
  messageType?: 'thought' | 'action' | 'observation' | 'system' | 'user' | 'assistant' | 'demonstration';
}

/**
 * Extended history item with optional fields
 */
export interface HistoryItem extends BaseHistoryItem {
  agent?: string;
  isDemo?: boolean;
  thought?: string;
  action?: string | null;
  toolCalls?: ToolCall[] | null;
  toolCallIds?: string[] | null;
  tags?: string[];
  cacheControl?: CacheControl | null;
  thinkingBlocks?: ThinkingBlock[] | null;
}

/**
 * History is an array of history items
 */
export type History = HistoryItem[];

/**
 * Agent information dictionary
 */
export interface AgentInfo {
  modelStats?: Record<string, number>;
  exitStatus?: string | null;
  submission?: string | null;
  review?: Record<string, unknown>;
  editedFiles30?: string;
  editedFiles50?: string;
  editedFiles70?: string;
  summarizer?: Record<string, unknown>;
  sweAgentHash?: string;
  sweAgentVersion?: string;
  sweRexVersion?: string;
  sweRexHash?: string;
  [key: string]: unknown; // Allow additional properties
}

/**
 * Result from an agent run
 */
export interface AgentRunResult {
  info: AgentInfo;
  trajectory: Trajectory;
}

// ============================================================================
// ADDITIONAL TYPE DEFINITIONS TO REPLACE 'any' TYPES
// ============================================================================

/**
 * Model response from LLM
 */
export interface ModelResponse {
  message: string;
  toolCalls?: ToolCall[];
  tool_calls?: ToolCall[];
  role?: string;
  content?: string | Array<{ type: string; text?: string; [key: string]: unknown }>;
}

/**
 * Environment variable configuration
 */
export type EnvVariables = Record<string, string | number | boolean>;

/**
 * Registry variables configuration
 */
export type RegistryVariables = Record<string, string | number | boolean>;

/**
 * Parsed command arguments
 */
export interface ParsedArguments {
  [argName: string]: string | number | boolean | string[] | undefined;
}

/**
 * Trajectory data for inspector
 */
export interface TrajectoryData {
  trajectory: Array<{
    thought?: string;
    action?: string;
    observation?: string;
    response?: string;
    execution_time?: number;
    state?: Record<string, string>;
    [key: string]: unknown;
  }>;
  info: Record<string, unknown>;
  history?: HistoryItem[];
  replay_config?: ReplayConfig;
}

/**
 * Replay configuration
 */
export interface ReplayConfig {
  environment?: Record<string, unknown>;
  agent?: Record<string, unknown>;
  tools?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * Spinner task state
 */
export interface SpinnerTask {
  status: string;
  startTime: number;
  instanceId?: string;
  message?: string;
}

/**
 * Instance statistics
 */
export interface InstanceStats {
  exitStatus: string | null;
  result?: string;
  cost?: number;
  apiCalls?: number;
}

/**
 * Command property for function calling tools
 */
export interface CommandProperty {
  type: string;
  description: string;
  enum?: string[];
  items?: Record<string, string>;
}

/**
 * Run hook context
 */
export interface RunContext {
  outputDir: string;
  config?: Record<string, unknown>;
  instanceCount?: number;
  [key: string]: unknown;
}

/**
 * Patch file info
 */
export interface PatchInfo {
  source: string;
  target: string;
  hunks: Array<{
    sourceStart: number;
    sourceLines: number;
    targetStart: number;
    targetLines: number;
    lines: string[];
  }>;
}

/**
 * File data type that can be JSON, YAML, or raw text
 */
export type FileData = Record<string, unknown> | string | unknown[];

/**
 * GitHub API issue response
 */
export interface GithubIssue {
  title: string;
  body: string | null;
  number: number;
  state: string;
  created_at: string;
  updated_at: string;
  user: {
    login: string;
    avatar_url: string;
  };
  labels: Array<{
    name: string;
    color: string;
  }>;
  [key: string]: unknown;
}

/**
 * GitHub API event response
 */
export interface GithubEvent {
  event: string;
  commit_id?: string;
  created_at: string;
  [key: string]: unknown;
}

/**
 * Template context for rendering
 */
export type TemplateContext = Record<
  string,
  string | number | boolean | unknown[] | Record<string, unknown> | null | undefined
>;

/**
 * Serializable data structure
 */
export type SerializableData =
  | string
  | number
  | boolean
  | null
  | undefined
  | SerializableData[]
  | { [key: string]: SerializableData };

/**
 * Command line argument value
 */
export type ArgValue = string | number | boolean | string[] | undefined;

/**
 * Parsed command line arguments
 */
export interface ParsedArgs {
  [key: string]: ArgValue | ParsedArgs;
}

/**
 * Error with code property
 */
export interface CodedError extends Error {
  code?: string;
  status?: number;
  stdout?: string;
  stderr?: string;
}
