/**
 * Shared types and helpers for the PTY service layer.
 *
 * Extracted from pty-service.ts to keep that module lean and allow
 * other modules (pty-spawn, pty-init, actions) to import lightweight
 * type-only dependencies without pulling in the full PTYService class.
 *
 * @module services/pty-types
 */

import type {
  AdapterType,
  AgentCredentials,
  ApprovalPreset,
} from "coding-agent-adapters";
import type { SessionHandle } from "pty-manager";

export interface PTYServiceConfig {
  /** Maximum output lines to keep per session (default: 1000) */
  maxLogLines?: number;
  /** Enable debug logging */
  debug?: boolean;
  /** Auto-register task-agent adapters (default: true) */
  registerCodingAdapters?: boolean;
  /** Maximum concurrent PTY sessions (default: 8) */
  maxConcurrentSessions?: number;
  /**
   * Default approval preset for task agents when not specified per-spawn.
   * Controls what tools the agent can use without asking for permission.
   *   - "readonly"   — Read-only tools only
   *   - "standard"   — Read + write, asks for shell/network
   *   - "permissive" — Most tools auto-approved, asks for destructive ops
   *   - "autonomous" — All tools auto-approved (yolo mode)
   * Default: "autonomous"
   */
  defaultApprovalPreset?: ApprovalPreset;
}

/** Available task-agent types */
export type CodingAgentType = "shell" | "pi" | "opencode" | AdapterType;

const PI_AGENT_ALIASES = new Set(["pi", "pi-coding-agent", "picodingagent"]);
const OPENCODE_AGENT_ALIASES = new Set([
  "opencode",
  "open-code",
  "opencodeagent",
]);

/** True when the user requested the Pi coding agent. */
export const isPiAgentType = (input: string | undefined | null): boolean => {
  if (!input) return false;
  return PI_AGENT_ALIASES.has(input.toLowerCase().trim());
};

/** True when the user requested the OpenCode agent. */
export const isOpencodeAgentType = (
  input: string | undefined | null,
): boolean => {
  if (!input) return false;
  return OPENCODE_AGENT_ALIASES.has(input.toLowerCase().trim());
};

/** Normalize user-provided agent type string to a valid CodingAgentType */
export const normalizeAgentType = (input: string): CodingAgentType => {
  const normalized = input.toLowerCase().trim();
  if (isPiAgentType(normalized)) {
    // PI currently runs through the generic shell adapter.
    return "shell";
  }
  if (isOpencodeAgentType(normalized)) {
    // OpenCode also runs through the generic shell adapter — see toOpencodeCommand.
    return "shell";
  }
  const mapping: Record<string, CodingAgentType> = {
    claude: "claude",
    "claude-code": "claude",
    claudecode: "claude",
    codex: "codex",
    openai: "codex",
    "openai-codex": "codex",
    gemini: "gemini",
    google: "gemini",
    aider: "aider",
    shell: "shell",
    bash: "shell",
  };
  return mapping[normalized] ?? "claude";
};

/** Build the initial shell command for Pi agent sessions. */
export const toPiCommand = (task: string | undefined): string => {
  const trimmed = task?.trim();
  if (!trimmed) return "pi";
  const shellSafe = `'${trimmed.replace(/'/g, `'"'"'`)}'`;
  return `pi ${shellSafe}`;
};

/**
 * Build the initial shell command for OpenCode agent sessions.
 *
 * `--dangerously-skip-permissions` is a flag of the `run` subcommand
 * (NOT the top-level opencode command), so it must come AFTER `run` —
 * verified live with opencode 1.14.33 + an OpenAI-compatible Eliza-1 endpoint.
 *
 * Model + provider selection comes from the OPENCODE_CONFIG_CONTENT env
 * var that the spawn pipeline injects — see buildOpencodeSpawnConfig in
 * `agent-credentials.ts`.
 */
export const toOpencodeCommand = (task: string | undefined): string => {
  const trimmed = task?.trim();
  if (!trimmed) return "opencode";
  const shellSafe = `'${trimmed.replace(/'/g, `'"'"'`)}'`;
  return `opencode run --dangerously-skip-permissions ${shellSafe}`;
};

export interface SpawnSessionOptions {
  /** Human-readable session name */
  name: string;
  /** Adapter type: "shell" | "pi" | "opencode" | "claude" | "gemini" | "codex" | "aider" */
  agentType: CodingAgentType;
  /** Working directory for the session */
  workdir?: string;
  /** Initial command/task to send */
  initialTask?: string;
  /** Environment variables */
  env?: Record<string, string>;
  /** Session metadata for tracking */
  metadata?: Record<string, unknown>;
  /** Credentials for coding agents (API keys, tokens) */
  credentials?: AgentCredentials;
  /** Memory/instructions content to write to the agent's memory file before spawning */
  memoryContent?: string;
  /** Approval preset controlling tool permissions (readonly, standard, permissive, autonomous) */
  approvalPreset?: ApprovalPreset;
  /** Custom credentials for MCP servers or other integrations */
  customCredentials?: Record<string, string>;
  /** When true, adapter-level blocking prompts (tool permissions, file access)
   *  are emitted with autoResponded=false instead of being auto-handled.
   *  Used by the swarm coordinator to route decisions through its LLM loop. */
  skipAdapterAutoResponse?: boolean;
}

export interface SessionInfo {
  id: string;
  name: string;
  agentType: string;
  workdir: string;
  status: SessionHandle["status"];
  createdAt: Date;
  lastActivityAt: Date;
  metadata?: Record<string, unknown>;
}

/** Known event names emitted by the PTY layer. */
export type SessionEventName =
  | "ready"
  | "blocked"
  | "login_required"
  | "task_complete"
  | "tool_running"
  | "stopped"
  | "error"
  | "message";

type SessionEventCallback = (
  sessionId: string,
  event: string,
  data: unknown,
) => void;

export type { SessionEventCallback };
