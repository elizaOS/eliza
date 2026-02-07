import type { MilaidyConfig } from "./types.js";

export interface ApplyPluginAutoEnableResult {
  config: MilaidyConfig;
  changes: string[];
}

export interface ApplyPluginAutoEnableParams {
  config: Partial<MilaidyConfig>;
  env: NodeJS.ProcessEnv;
}

export const CHANNEL_PLUGINS: Record<string, string> = {
  telegram: "@elizaos/plugin-telegram",
  discord: "@elizaos/plugin-discord",
  slack: "@elizaos/plugin-slack",
  twitter: "@elizaos/plugin-twitter",
  whatsapp: "@elizaos/plugin-whatsapp",
  signal: "@elizaos/plugin-signal",
  bluebubbles: "@elizaos/plugin-bluebubbles",
  imessage: "@elizaos/plugin-imessage",
  farcaster: "@elizaos/plugin-farcaster",
  lens: "@elizaos/plugin-lens",
  msteams: "@elizaos/plugin-msteams",
  mattermost: "@elizaos/plugin-mattermost",
  googlechat: "@elizaos/plugin-google-chat",
  feishu: "@elizaos/plugin-feishu",
  matrix: "@elizaos/plugin-matrix",
  nostr: "@elizaos/plugin-nostr",
};

const PROVIDER_PLUGINS: Record<string, string> = {
  "google-antigravity": "@elizaos/plugin-google-antigravity",
  "google-gemini": "@elizaos/plugin-google-gemini",
  openai: "@elizaos/plugin-openai",
  anthropic: "@elizaos/plugin-anthropic",
  qwen: "@elizaos/plugin-qwen",
  minimax: "@elizaos/plugin-minimax",
  groq: "@elizaos/plugin-groq",
  xai: "@elizaos/plugin-xai",
  openrouter: "@elizaos/plugin-openrouter",
  ollama: "@elizaos/plugin-ollama",
  deepseek: "@elizaos/plugin-deepseek",
  together: "@elizaos/plugin-together",
  mistral: "@elizaos/plugin-mistral",
  cohere: "@elizaos/plugin-cohere",
  perplexity: "@elizaos/plugin-perplexity",
};

export const AUTH_PROVIDER_PLUGINS: Record<string, string> = {
  ANTHROPIC_API_KEY: "@elizaos/plugin-anthropic",
  CLAUDE_API_KEY: "@elizaos/plugin-anthropic",
  OPENAI_API_KEY: "@elizaos/plugin-openai",
  GOOGLE_API_KEY: "@elizaos/plugin-google-gemini",
  GOOGLE_GENERATIVE_AI_API_KEY: "@elizaos/plugin-google-gemini",
  GOOGLE_CLOUD_API_KEY: "@elizaos/plugin-google-antigravity",
  GROQ_API_KEY: "@elizaos/plugin-groq",
  XAI_API_KEY: "@elizaos/plugin-xai",
  GROK_API_KEY: "@elizaos/plugin-xai",
  OPENROUTER_API_KEY: "@elizaos/plugin-openrouter",
  OLLAMA_BASE_URL: "@elizaos/plugin-ollama",
  DEEPSEEK_API_KEY: "@elizaos/plugin-deepseek",
  TOGETHER_API_KEY: "@elizaos/plugin-together",
  MISTRAL_API_KEY: "@elizaos/plugin-mistral",
  COHERE_API_KEY: "@elizaos/plugin-cohere",
  PERPLEXITY_API_KEY: "@elizaos/plugin-perplexity",
};

const FEATURE_PLUGINS: Record<string, string> = {
  browser: "@elizaos/plugin-browser",
  cron: "@elizaos/plugin-cron",
  shell: "@elizaos/plugin-shell",
  imageGen: "@elizaos/plugin-image-generation",
  tts: "@elizaos/plugin-tts",
  stt: "@elizaos/plugin-stt",
  agentSkills: "@elizaos/plugin-agent-skills",
  directives: "@elizaos/plugin-directives",
  commands: "@elizaos/plugin-commands",
  diagnosticsOtel: "@elizaos/plugin-diagnostics-otel",
  webhooks: "@elizaos/plugin-webhooks",
  gmailWatch: "@elizaos/plugin-gmail-watch",
  personality: "@elizaos/plugin-personality",
  experience: "@elizaos/plugin-experience",
  form: "@elizaos/plugin-form",
};

function isChannelConfigured(channelName: string, channelConfig: unknown): boolean {
  if (!channelConfig || typeof channelConfig !== "object") {
    return false;
  }
  const config = channelConfig as Record<string, unknown>;
  if (config.enabled === false) {
    return false;
  }
  if (config.botToken || config.token || config.apiKey) {
    return true;
  }
  switch (channelName) {
    case "bluebubbles":
      return Boolean(config.serverUrl && config.password);
    case "imessage":
      return Boolean(config.cliPath);
    case "whatsapp":
      return Boolean(config.authState || config.sessionPath);
    default:
      return false;
  }
}

function addToAllowlist(
  allow: string[],
  pluginName: string,
  shortId: string,
  changes: string[],
  reason: string,
): void {
  if (!allow.includes(pluginName) && !allow.includes(shortId)) {
    allow.push(shortId);
    changes.push(`Auto-enabled plugin: ${pluginName} (${reason})`);
  }
}

export function applyPluginAutoEnable(
  params: ApplyPluginAutoEnableParams,
): ApplyPluginAutoEnableResult {
  const { config, env } = params;
  const changes: string[] = [];
  const updatedConfig = structuredClone(config) as MilaidyConfig;

  if (
    updatedConfig.plugins &&
    typeof updatedConfig.plugins === "object" &&
    (updatedConfig.plugins as Record<string, unknown>).enabled === false
  ) {
    return { config: updatedConfig, changes };
  }

  updatedConfig.plugins = updatedConfig.plugins ?? {};
  const pluginsConfig = updatedConfig.plugins as {
    allow?: string[];
    entries?: Record<string, { enabled?: boolean }>;
  };
  pluginsConfig.allow = pluginsConfig.allow ?? [];
  pluginsConfig.entries = pluginsConfig.entries ?? {};

  // Channels
  if (updatedConfig.channels && typeof updatedConfig.channels === "object") {
    for (const [channelName, channelConfig] of Object.entries(updatedConfig.channels)) {
      const pluginName = CHANNEL_PLUGINS[channelName];
      if (!pluginName) continue;
      if (!isChannelConfigured(channelName, channelConfig)) continue;
      if (pluginsConfig.entries[channelName]?.enabled === false) continue;
      addToAllowlist(pluginsConfig.allow, pluginName, channelName, changes, `channel: ${channelName}`);
    }
  }

  // Auth profiles
  if (updatedConfig.auth && typeof updatedConfig.auth === "object" && (updatedConfig.auth as Record<string, unknown>).profiles) {
    const profiles = (updatedConfig.auth as Record<string, unknown>).profiles as Record<string, { provider?: string }>;
    for (const [profileKey, profile] of Object.entries(profiles)) {
      const provider = profile.provider;
      if (!provider) continue;
      const pluginName = PROVIDER_PLUGINS[provider];
      if (!pluginName) continue;
      addToAllowlist(pluginsConfig.allow, pluginName, provider, changes, `auth profile: ${profileKey}`);
    }
  }

  // Env var API keys
  for (const [envKey, pluginName] of Object.entries(AUTH_PROVIDER_PLUGINS)) {
    const envValue = env[envKey];
    if (!envValue || typeof envValue !== "string" || envValue.trim() === "") continue;
    const pluginId = pluginName.replace("@elizaos/plugin-", "");
    if (pluginsConfig.entries[pluginId]?.enabled === false) continue;
    addToAllowlist(pluginsConfig.allow, pluginName, pluginId, changes, `env: ${envKey}`);
  }

  // Feature flags
  if (updatedConfig.features && typeof updatedConfig.features === "object") {
    const features = updatedConfig.features as Record<string, unknown>;
    for (const [featureName, featureConfig] of Object.entries(features)) {
      const pluginName = FEATURE_PLUGINS[featureName];
      if (!pluginName) continue;
      const isEnabled = featureConfig === true ||
        (featureConfig && typeof featureConfig === "object" &&
          (featureConfig as Record<string, unknown>).enabled !== false);
      if (!isEnabled) continue;
      const pluginId = pluginName.replace("@elizaos/plugin-", "");
      if (pluginsConfig.entries[pluginId]?.enabled === false) continue;
      addToAllowlist(pluginsConfig.allow, pluginName, pluginId, changes, `feature: ${featureName}`);
    }
  }

  // Hooks: webhooks + gmail
  const hooksConfig = (updatedConfig as Record<string, unknown>).hooks as Record<string, unknown> | undefined;
  if (hooksConfig && hooksConfig.enabled !== false && hooksConfig.token) {
    const webhooksPlugin = FEATURE_PLUGINS.webhooks;
    if (webhooksPlugin) {
      addToAllowlist(pluginsConfig.allow, webhooksPlugin, webhooksPlugin.replace("@elizaos/plugin-", ""), changes, "hooks.token");
    }
  }
  if (hooksConfig) {
    const gmailConfig = (hooksConfig.gmail ?? {}) as Record<string, unknown>;
    if (typeof gmailConfig.account === "string" && gmailConfig.account.trim()) {
      const gmailPlugin = FEATURE_PLUGINS.gmailWatch;
      if (gmailPlugin) {
        addToAllowlist(pluginsConfig.allow, gmailPlugin, gmailPlugin.replace("@elizaos/plugin-", ""), changes, "hooks.gmail.account");
      }
    }
  }

  return { config: updatedConfig, changes };
}
