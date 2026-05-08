/**
 * Agent Mode Types
 * Defines the backend message-processing mode.
 */

/**
 * Available agent modes for message processing
 */
export enum AgentMode {
  /** Chat mode - single backend message-processing mode */
  CHAT = "chat",
}

/**
 * Agent mode configuration passed with messages
 */
export interface AgentModeConfig {
  /** The operational mode for this interaction */
  mode: AgentMode;

  /** Optional metadata for mode-specific parameters */
  metadata?: Record<string, unknown>;
}

/**
 * Default agent mode configuration
 */
export const DEFAULT_AGENT_MODE: AgentModeConfig = {
  mode: AgentMode.CHAT,
};

/**
 * Type guard to check if a value is a valid AgentMode
 */
export function isValidAgentMode(mode: unknown): mode is AgentMode {
  return typeof mode === "string" && Object.values(AgentMode).includes(mode as AgentMode);
}

/**
 * Type guard to check if a value is a valid AgentModeConfig
 */
export function isValidAgentModeConfig(config: unknown): config is AgentModeConfig {
  if (!config || typeof config !== "object") {
    return false;
  }

  const cfg = config as Record<string, unknown>;

  // Check if mode is valid
  if (!cfg.mode || !isValidAgentMode(cfg.mode)) {
    return false;
  }

  // Check metadata if present
  if (cfg.metadata !== undefined) {
    if (typeof cfg.metadata !== "object" || cfg.metadata === null || Array.isArray(cfg.metadata)) {
      return false;
    }
  }

  return true;
}

/**
 * Plugin sets for each agent mode
 * Conditional plugins are injected separately from character settings.
 */
export const AGENT_MODE_PLUGINS = {
  [AgentMode.CHAT]: ["@elizaos/plugin-elizacloud"],
} as const;

/**
 * MCP server configuration
 */
interface McpServerConfig {
  type: string;
  url: string;
}

/**
 * Settings-based plugin configuration types
 * Used to detect which conditional plugins should be loaded
 */
export interface ConditionalPluginSettings {
  mcp?: {
    servers: Record<string, McpServerConfig>;
  };
  webSearch?: {
    enabled: boolean;
  };
  n8n?: Record<string, unknown>;
}

/**
 * Maps settings keys to plugin names.
 * When a key exists in character settings, the corresponding plugin is injected.
 */
export const SETTINGS_PLUGIN_MAP = {
  mcp: "@elizaos/plugin-mcp",
  webSearch: "@elizaos/plugin-web-search",
  n8n: "@elizaos/plugin-n8n-workflow",
} as const satisfies Record<keyof ConditionalPluginSettings, string>;

/**
 * Validates that conditional plugin settings have actual configuration.
 * Prevents injecting plugins when settings exist but are empty (e.g., { mcp: { servers: {} } }).
 */
function hasValidConfiguration(
  key: keyof typeof SETTINGS_PLUGIN_MAP,
  settings: Record<string, unknown>,
): boolean {
  if (key === "n8n") {
    const secrets =
      settings.secrets && typeof settings.secrets === "object"
        ? (settings.secrets as Record<string, unknown>)
        : {};
    const apiKey = settings.N8N_API_KEY ?? secrets.N8N_API_KEY;
    const host = settings.N8N_HOST ?? secrets.N8N_HOST;
    return (
      typeof apiKey === "string" && apiKey.length > 0 && typeof host === "string" && host.length > 0
    );
  }

  const value = settings[key];
  if (value == null) return false;

  switch (key) {
    case "mcp": {
      const mcpSettings = value as ConditionalPluginSettings["mcp"];
      return mcpSettings?.servers != null && Object.keys(mcpSettings.servers).length > 0;
    }
    case "webSearch": {
      const webSearchSettings = value as ConditionalPluginSettings["webSearch"];
      return webSearchSettings?.enabled === true;
    }
    default:
      return false;
  }
}

/**
 * Get plugins that should be injected based on character settings.
 * Only returns plugins when settings contain actual configuration.
 */
export function getConditionalPlugins(settings: Record<string, unknown>): string[] {
  return Object.entries(SETTINGS_PLUGIN_MAP)
    .filter(([key]) => hasValidConfiguration(key as keyof typeof SETTINGS_PLUGIN_MAP, settings))
    .map(([, pluginName]) => pluginName);
}
