/**
 * Agent Mode Types
 * Defines how the agent processes messages based on different operational modes
 */

/**
 * Available agent modes for message processing
 * Each mode loads a specific set of plugins optimized for that use case
 */
export enum AgentMode {
  /** Chat mode - Fast single-shot responses for playground/simple conversations */
  CHAT = "chat",

  /** Build mode - Agent assists in creating/modifying character files */
  BUILD = "build",

  /** Assistant mode - Planning-based with action execution and knowledge access */
  ASSISTANT = "assistant",
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
  return (
    typeof mode === "string" &&
    Object.values(AgentMode).includes(mode as AgentMode)
  );
}

/**
 * Type guard to check if a value is a valid AgentModeConfig
 */
export function isValidAgentModeConfig(
  config: unknown,
): config is AgentModeConfig {
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
    if (
      typeof cfg.metadata !== "object" ||
      cfg.metadata === null ||
      Array.isArray(cfg.metadata)
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Plugin sets for each agent mode
 * These define which plugins are loaded for each operational mode
 * NOTE: Knowledge and WebSearch plugins are conditionally loaded - not included in base sets
 */
export const AGENT_MODE_PLUGINS = {
  [AgentMode.CHAT]: [
    "@elizaos/plugin-elizacloud",
    "@eliza-cloud/plugin-chat-playground",
    "@elizaos/plugin-memory",
  ],
  [AgentMode.BUILD]: [
    "@elizaos/plugin-elizacloud",
    "@eliza-cloud/plugin-character-builder",
    "@elizaos/plugin-memory",
  ],
  [AgentMode.ASSISTANT]: [
    "@elizaos/plugin-elizacloud",
    "@eliza-cloud/plugin-assistant",
    "@eliza-cloud/plugin-oauth",
    "@elizaos/plugin-memory",
  ],
} as const;

/**
 * MCP server configuration
 */
interface McpServerConfig {
  type: string;
  url: string;
}

/**
 * Affiliate character data configuration
 * When present, swaps plugin-assistant for plugin-affiliate
 */
export interface AffiliateData {
  vibe?: string;
  affiliateId?: string;
  autoImage?: boolean;
  imageUrls?: string[];
  [key: string]: unknown;
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
}

/**
 * Maps settings keys to plugin names.
 * When a key exists in character settings, the corresponding plugin is injected.
 */
export const SETTINGS_PLUGIN_MAP = {
  mcp: "@elizaos/plugin-mcp",
  webSearch: "@elizaos/plugin-web-search",
} as const satisfies Record<keyof ConditionalPluginSettings, string>;

/**
 * Validates that conditional plugin settings have actual configuration.
 * Prevents injecting plugins when settings exist but are empty (e.g., { mcp: { servers: {} } }).
 */
function hasValidConfiguration(
  key: keyof typeof SETTINGS_PLUGIN_MAP,
  settings: Record<string, unknown>,
): boolean {
  const value = settings[key];
  if (value == null) return false;

  switch (key) {
    case "mcp": {
      const mcpSettings = value as ConditionalPluginSettings["mcp"];
      return (
        mcpSettings?.servers != null &&
        Object.keys(mcpSettings.servers).length > 0
      );
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
export function getConditionalPlugins(
  settings: Record<string, unknown>,
): string[] {
  return Object.entries(SETTINGS_PLUGIN_MAP)
    .filter(([key]) =>
      hasValidConfiguration(key as keyof typeof SETTINGS_PLUGIN_MAP, settings),
    )
    .map(([, pluginName]) => pluginName);
}

/**
 * Check if character settings require ASSISTANT mode upgrade.
 * Only returns a key when settings contain actual configuration.
 */
export function requiresAssistantMode(
  settings: Record<string, unknown>,
): keyof typeof SETTINGS_PLUGIN_MAP | null {
  for (const key of Object.keys(SETTINGS_PLUGIN_MAP)) {
    if (
      hasValidConfiguration(key as keyof typeof SETTINGS_PLUGIN_MAP, settings)
    ) {
      return key as keyof typeof SETTINGS_PLUGIN_MAP;
    }
  }
  return null;
}

/**
 * Check if character has affiliate data configured.
 * When true, plugin-affiliate should be loaded instead of plugin-assistant.
 */
export function hasAffiliateData(settings: Record<string, unknown>): boolean {
  const affiliateData = settings.affiliateData as AffiliateData | undefined;
  return affiliateData != null && Object.keys(affiliateData).length > 0;
}
