import type { IAgentRuntime } from "@elizaos/core";
import type {
  CodeTask,
  JsonValue,
  ProgressUpdate,
  TaskResult,
  TaskTraceEvent,
} from "../../types.js";

/**
 * Result from executing a tool
 */
export interface ToolResult {
  success: boolean;
  output: string;
  data?: Record<string, JsonValue>;
}

/**
 * Tool parameter definition
 */
export interface ToolParameter {
  name: string;
  description: string;
  required?: boolean;
}

/**
 * Tool available to sub-agents for task execution
 */
export interface SubAgentTool {
  name: string;
  description: string;
  parameters: ToolParameter[];
  execute: (args: Record<string, string>) => Promise<ToolResult>;
}

/**
 * Context provided to sub-agents during execution
 */
export interface SubAgentContext {
  runtime: IAgentRuntime;
  workingDirectory: string;
  tools: SubAgentTool[];
  /** Report progress back to main agent */
  onProgress: (update: ProgressUpdate) => void;
  /** Report important messages to user */
  onMessage: (message: string, priority: "info" | "warning" | "error") => void;
  onTrace?: (event: TaskTraceEvent) => void;
  /** Check if execution should stop */
  isCancelled: () => boolean;
  /** Check if execution should pause (no model/tool calls while paused). */
  isPaused?: () => boolean;
}

/**
 * Sub-agent interface for executing tasks
 */
export interface SubAgent {
  readonly name: string;
  readonly type: "eliza" | "claude";

  /** Execute a task and return the result */
  execute(task: CodeTask, context: SubAgentContext): Promise<TaskResult>;

  /** Cancel execution */
  cancel(): void;
}

// Re-export types used by tools
export type { CodeTask, TaskResult, ProgressUpdate };
