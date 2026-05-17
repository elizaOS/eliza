import type {
  GroupChatConfig,
  HumanDelayConfig,
  IdentityConfig,
} from "@elizaos/core";
import type {
  AgentDefaultsConfig,
  SandboxBrowserSettings,
  SandboxDockerSettings,
  SandboxPruneSettings,
} from "./types.agent-defaults.js";
import type { AgentToolsConfig, MemorySearchConfig } from "./types.tools.js";

export type AgentModelConfig =
  | string
  | {
      /** Primary model (provider/model). */
      primary?: string;
      /** Per-agent model fallbacks (provider/model). */
      fallbacks?: string[];
    };

export type AgentConfig = {
  id: string;
  default?: boolean;
  name?: string;
  username?: string;
  workspace?: string;
  agentDir?: string;
  model?: AgentModelConfig;
  /** Optional allowlist of skills for this agent (omit = all skills; empty = none). */
  skills?: string[];
  memorySearch?: MemorySearchConfig;
  /** Human-like delay between block replies for this agent. */
  humanDelay?: HumanDelayConfig;
  /** Optional per-agent heartbeat overrides. */
  heartbeat?: AgentDefaultsConfig["heartbeat"];
  identity?: IdentityConfig;
  groupChat?: GroupChatConfig;
  /** Enable built-in advanced memory providers/evaluators for this agent. */
  advancedMemory?: boolean;
  /** Enable built-in agent orchestrator (PTY / coding task agents) for this agent. */
  agentOrchestrator?: boolean;

  // ── Personality fields (set during onboarding from style presets) ──────
  /** Agent bio lines. Set during onboarding from the chosen style preset. */
  bio?: string[];
  /** System prompt. Set during onboarding from the chosen style preset. */
  system?: string;
  /** Communication style rules. Set during onboarding from the chosen style preset. */
  style?: { all?: string[]; chat?: string[]; post?: string[] };
  /** Personality adjectives. Set during onboarding from the chosen style preset. */
  adjectives?: string[];
  /** Conversation topics the agent is knowledgeable about. */
  topics?: string[];
  /** Example social media posts demonstrating the agent's voice. */
  postExamples?: string[];
  /** Example social media posts in Chinese (zh-CN) demonstrating the agent's voice. */
  postExamples_zhCN?: string[];
  messageExamples?: Array<Array<{ user: string; content: { text: string } }>>;
  subagents?: {
    /** Allow spawning sub-agents under other agent ids. Use "*" to allow any. */
    allowAgents?: string[];
    /** Per-agent default model for spawned sub-agents (string or {primary,fallbacks}). */
    model?: string | { primary?: string; fallbacks?: string[] };
  };
  sandbox?: {
    mode?: "off" | "non-main" | "all";
    /** Agent workspace access inside the sandbox. */
    workspaceAccess?: "none" | "ro" | "rw";
    /**
     * Session tools visibility for sandboxed sessions.
     * - "spawned": only allow session tools to target sessions spawned from this session (default)
     * - "all": allow session tools to target any session
     */
    sessionToolsVisibility?: "spawned" | "all";
    /** Container/workspace scope for sandbox isolation. */
    scope?: "session" | "agent" | "shared";
    /** Legacy alias for scope ("session" when true, "shared" when false). */
    perSession?: boolean;
    workspaceRoot?: string;
    /** Docker-specific sandbox overrides for this agent. */
    docker?: SandboxDockerSettings;
    /** Optional sandboxed browser overrides for this agent. */
    browser?: SandboxBrowserSettings;
    /** Auto-prune overrides for this agent. */
    prune?: SandboxPruneSettings;
  };
  tools?: AgentToolsConfig;

  /** Cloud deployment info (set when agent runs in Eliza Cloud). */
  cloud?: {
    /** Eliza Cloud agent record ID. */
    cloudAgentId?: string;
    /** Last known sandbox status. */
    lastStatus?: string;
    /** ISO timestamp when the agent was last provisioned. */
    lastProvisionedAt?: string;
  };
};

export type AgentsConfig = {
  defaults?: AgentDefaultsConfig;
  list?: AgentConfig[];
};

export type AgentBinding = {
  agentId: string;
  match: {
    channel: string;
    accountId?: string;
    peer?: { kind: "dm" | "group" | "channel"; id: string };
    guildId?: string;
    teamId?: string;
  };
};
