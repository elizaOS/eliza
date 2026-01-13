import type { IAgentRuntime } from "@elizaos/core";
import type {
  CodeTask,
  JsonValue,
  ProgressUpdate,
  SubAgentConfig,
  SubAgentGoal,
  SubAgentTodo,
  SubAgentType,
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
  type?: "string" | "number" | "boolean";
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
 * MCP tool definition for external tools via Model Context Protocol
 */
export interface McpToolDefinition {
  name: string;
  description: string;
  server: string;
  inputSchema: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

/**
 * Context provided to sub-agents during execution
 */
export interface SubAgentContext {
  /** ElizaOS runtime for model access and services */
  runtime: IAgentRuntime;
  /** Working directory for file operations */
  workingDirectory: string;
  /** Core file/shell tools available to the sub-agent */
  tools: SubAgentTool[];
  /** MCP tools from connected servers (e.g., Context7) */
  mcpTools?: McpToolDefinition[];
  /** Active goals from the goals plugin */
  goals?: SubAgentGoal[];
  /** Active todos from the todo plugin */
  todos?: SubAgentTodo[];
  /** Configuration options for the sub-agent */
  config?: SubAgentConfig;
  /** Report progress back to main agent */
  onProgress: (update: ProgressUpdate) => void;
  /** Report important messages to user */
  onMessage: (message: string, priority: "info" | "warning" | "error") => void;
  /** Report trace events for debugging/logging */
  onTrace?: (event: TaskTraceEvent) => void;
  /** Create a todo item during task execution */
  createTodo?: (name: string, description?: string) => Promise<SubAgentTodo>;
  /** Complete a todo item during task execution */
  completeTodo?: (id: string) => Promise<void>;
  /** Check if execution should stop */
  isCancelled: () => boolean;
  /** Check if execution should pause (no model/tool calls while paused). */
  isPaused?: () => boolean;
  /** Call an MCP tool */
  callMcpTool?: (
    server: string,
    toolName: string,
    args: Record<string, string>,
  ) => Promise<ToolResult>;
}

/**
 * Sub-agent interface for executing tasks
 */
export interface SubAgent {
  readonly name: string;
  /**
   * Worker flavor (used by the orchestrator to select an implementation).
   * - eliza: default tool-calling worker using the runtime model
   * - claude-code: Claude Code–style worker (SDK or prompt-based)
   * - codex: Codex-style worker (SDK or prompt-based)
   * - opencode: OpenCode CLI-based worker
   * - sweagent: SWE-agent methodology worker (Think/Act pattern)
   * - elizaos-native: Best-of-all native ElizaOS agent
   *
   * Note: "claude" is kept for backwards compatibility and maps to "claude-code".
   */
  readonly type: SubAgentType;

  /** Execute a task and return the result */
  execute(task: CodeTask, context: SubAgentContext): Promise<TaskResult>;

  /** Cancel execution */
  cancel(): void;
}

/**
 * Re-export types for convenience
 */
export type {
  CodeTask,
  JsonValue,
  ProgressUpdate,
  SubAgentConfig,
  SubAgentGoal,
  SubAgentTodo,
  SubAgentType,
  TaskResult,
  TaskTraceEvent,
};
