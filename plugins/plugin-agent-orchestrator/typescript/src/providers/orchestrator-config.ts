import type { IAgentRuntime, Memory, Provider, ProviderResult, State } from "@elizaos/core";
import type { SubagentConfig } from "../types/subagent.js";
import type { SandboxConfig } from "../types/sandbox.js";

/**
 * Configuration schema for the agent orchestrator plugin.
 *
 * This configuration is read from Character.settings and provides
 * the settings for subagent spawning, sandboxed execution, and
 * agent-to-agent communication.
 *
 * Example Character configuration:
 *
 * ```json
 * {
 *   "name": "MyAgent",
 *   "settings": {
 *     "subagents": {
 *       "enabled": true,
 *       "model": "anthropic/claude-3-sonnet",
 *       "thinking": "medium",
 *       "timeoutSeconds": 300,
 *       "allowAgents": ["*"],
 *       "archiveAfterMinutes": 60
 *     },
 *     "agentToAgent": {
 *       "enabled": true,
 *       "allow": [
 *         { "source": "*", "target": "*" }
 *       ]
 *     },
 *     "sandbox": {
 *       "mode": "non-main",
 *       "scope": "session",
 *       "workspaceAccess": "rw",
 *       "workspaceRoot": "~/.eliza/sandboxes",
 *       "docker": {
 *         "image": "ubuntu:22.04",
 *         "memoryLimit": "2g",
 *         "cpuLimit": "2",
 *         "network": "none"
 *       },
 *       "browser": {
 *         "enabled": false
 *       },
 *       "tools": {
 *         "allow": ["*"],
 *         "deny": ["rm -rf /*"]
 *       }
 *     }
 *   }
 * }
 * ```
 */
export interface OrchestratorConfig {
  /** Subagent spawning configuration */
  subagents: SubagentConfig;

  /** Agent-to-agent communication configuration */
  agentToAgent: {
    /** Whether A2A messaging is enabled */
    enabled: boolean;
    /** Allow rules for cross-agent communication */
    allow: Array<{
      /** Source agent pattern (* = any) */
      source: string;
      /** Target agent pattern (* = any) */
      target: string;
    }>;
  };

  /** Sandbox execution configuration */
  sandbox: Partial<SandboxConfig>;
}

/**
 * Default configuration values.
 */
const DEFAULT_CONFIG: OrchestratorConfig = {
  subagents: {
    enabled: true,
    timeoutSeconds: 300,
    allowAgents: [],
    archiveAfterMinutes: 60,
  },
  agentToAgent: {
    enabled: false,
    allow: [],
  },
  sandbox: {
    mode: "off",
    scope: "session",
    workspaceAccess: "rw",
  },
};

/**
 * Reads the orchestrator configuration from Character settings.
 */
export function getOrchestratorConfig(runtime: IAgentRuntime): OrchestratorConfig {
  const settings = runtime.character?.settings as Record<string, unknown> | undefined;

  if (!settings) {
    return DEFAULT_CONFIG;
  }

  const subagentsRaw = (settings.subagents ?? {}) as Partial<SubagentConfig>;
  const a2aRaw = (settings.agentToAgent ?? {}) as Partial<OrchestratorConfig["agentToAgent"]>;
  const sandboxRaw = (settings.sandbox ?? {}) as Partial<SandboxConfig>;

  // Build subagents config, only including defined optional values
  const subagents: OrchestratorConfig["subagents"] = {
    enabled: subagentsRaw.enabled ?? DEFAULT_CONFIG.subagents.enabled,
    timeoutSeconds: subagentsRaw.timeoutSeconds ?? DEFAULT_CONFIG.subagents.timeoutSeconds,
    allowAgents: subagentsRaw.allowAgents ?? DEFAULT_CONFIG.subagents.allowAgents,
    archiveAfterMinutes:
      subagentsRaw.archiveAfterMinutes ?? DEFAULT_CONFIG.subagents.archiveAfterMinutes,
  };
  if (subagentsRaw.model) subagents.model = subagentsRaw.model;
  if (subagentsRaw.thinking) subagents.thinking = subagentsRaw.thinking;

  return {
    subagents,
    agentToAgent: {
      enabled: a2aRaw.enabled ?? DEFAULT_CONFIG.agentToAgent.enabled,
      allow: a2aRaw.allow ?? DEFAULT_CONFIG.agentToAgent.allow,
    },
    sandbox: {
      ...DEFAULT_CONFIG.sandbox,
      ...sandboxRaw,
    },
  };
}

/**
 * Formats the orchestrator configuration as a context string.
 */
function formatConfigContext(config: OrchestratorConfig): string {
  const lines: string[] = ["## Orchestrator Configuration", ""];

  // Subagent config
  lines.push("### Subagents");
  lines.push(`- Enabled: ${config.subagents.enabled}`);
  if (config.subagents.model) {
    lines.push(`- Default Model: ${config.subagents.model}`);
  }
  if (config.subagents.thinking) {
    lines.push(`- Thinking Level: ${config.subagents.thinking}`);
  }
  lines.push(`- Timeout: ${config.subagents.timeoutSeconds}s`);
  const allowAgents = config.subagents.allowAgents ?? [];
  if (allowAgents.length > 0) {
    lines.push(`- Allowed Agents: ${allowAgents.join(", ")}`);
  }
  lines.push("");

  // A2A config
  lines.push("### Agent-to-Agent Communication");
  lines.push(`- Enabled: ${config.agentToAgent.enabled}`);
  if (config.agentToAgent.allow.length > 0) {
    lines.push("- Allow Rules:");
    for (const rule of config.agentToAgent.allow) {
      lines.push(`  - ${rule.source} → ${rule.target}`);
    }
  }
  lines.push("");

  // Sandbox config
  lines.push("### Sandbox");
  lines.push(`- Mode: ${config.sandbox.mode ?? "off"}`);
  lines.push(`- Scope: ${config.sandbox.scope ?? "session"}`);
  lines.push(`- Workspace Access: ${config.sandbox.workspaceAccess ?? "rw"}`);
  lines.push("");

  return lines.join("\n");
}

/**
 * Provider that exposes orchestrator configuration to the agent context.
 */
export const orchestratorConfigProvider: Provider = {
  name: "orchestrator_config",
  description: "Provides orchestrator configuration including subagents, A2A, and sandbox settings",
  get: async (runtime: IAgentRuntime, _message: Memory, _state?: State): Promise<ProviderResult> => {
    const config = getOrchestratorConfig(runtime);
    return { text: formatConfigContext(config) };
  },
};
