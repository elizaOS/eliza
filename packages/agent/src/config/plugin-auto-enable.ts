import { SUBSCRIPTION_PROVIDER_MAP } from "../auth/types";
import type { ElizaConfig } from "./types";

export interface ApplyPluginAutoEnableResult {
  config: ElizaConfig;
  changes: string[];
}

export interface ApplyPluginAutoEnableParams {
  config: Partial<ElizaConfig>;
  env: NodeJS.ProcessEnv;
}

export const CONNECTOR_PLUGINS: Record<string, string> = {
  telegram: "@elizaos/plugin-telegram",
  discord: "@elizaos/plugin-discord",
  slack: "@elizaos/plugin-slack",
  twitter: "@elizaos/plugin-twitter",
  // Internal connector built from src/plugins/whatsapp (not an npm package).
  whatsapp: "@elizaos/plugin-whatsapp",
  // Internal connector built from src/plugins/signal (not an npm package).
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
  retake: "@elizaos/plugin-retake",
  blooio: "@elizaos/plugin-blooio",
  twitch: "@elizaos/plugin-twitch",
};

export const STREAMING_PLUGINS: Record<string, string> = {
  retake: "@elizaos/plugin-retake",
  twitch: "@elizaos/plugin-twitch-streaming",
  youtube: "@elizaos/plugin-youtube-streaming",
  customRtmp: "@elizaos/plugin-custom-rtmp",
  pumpfun: "@elizaos/plugin-pumpfun-streaming",
  x: "@elizaos/plugin-x-streaming",
};

const PROVIDER_PLUGINS: Record<string, string> = {
  "google-antigravity": "@elizaos/plugin-google-antigravity",
  "google-gemini": "@elizaos/plugin-google-gemini",
  "vercel-ai-gateway": "@elizaos/plugin-vercel-ai-gateway",
  openai: "@elizaos/plugin-openai",
  anthropic: "@elizaos/plugin-anthropic",
  "pi-ai": "@elizaos/plugin-pi-ai",
  qwen: "@elizaos/plugin-qwen",
  minimax: "@elizaos/plugin-minimax",
  groq: "@elizaos/plugin-groq",
  xai: "@elizaos/plugin-xai",
  openrouter: "@elizaos/plugin-openrouter",
  ollama: "@elizaos/plugin-ollama",
  zai: "@homunculuslabs/plugin-zai",
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
  AI_GATEWAY_API_KEY: "@elizaos/plugin-vercel-ai-gateway",
  AIGATEWAY_API_KEY: "@elizaos/plugin-vercel-ai-gateway",
  GOOGLE_API_KEY: "@elizaos/plugin-google-gemini",
  GOOGLE_GENERATIVE_AI_API_KEY: "@elizaos/plugin-google-gemini",
  GOOGLE_CLOUD_API_KEY: "@elizaos/plugin-google-antigravity",
  GROQ_API_KEY: "@elizaos/plugin-groq",
  XAI_API_KEY: "@elizaos/plugin-xai",
  GROK_API_KEY: "@elizaos/plugin-xai",
  OPENROUTER_API_KEY: "@elizaos/plugin-openrouter",
  OLLAMA_BASE_URL: "@elizaos/plugin-ollama",
  ZAI_API_KEY: "@homunculuslabs/plugin-zai",
  DEEPSEEK_API_KEY: "@elizaos/plugin-deepseek",
  TOGETHER_API_KEY: "@elizaos/plugin-together",
  MISTRAL_API_KEY: "@elizaos/plugin-mistral",
  COHERE_API_KEY: "@elizaos/plugin-cohere",
  PERPLEXITY_API_KEY: "@elizaos/plugin-perplexity",
  ELIZAOS_CLOUD_API_KEY: "@elizaos/plugin-elizacloud",
  ELIZAOS_CLOUD_ENABLED: "@elizaos/plugin-elizacloud",
  ELIZA_USE_PI_AI: "@elizaos/plugin-pi-ai",
  CUA_API_KEY: "@elizaos/plugin-cua",
  CUA_HOST: "@elizaos/plugin-cua",
  OBSIDIAN_VAULT_PATH: "@elizaos/plugin-obsidian",
  OBSIDAN_VAULT_PATH: "@elizaos/plugin-obsidian",
  REPOPROMPT_CLI_PATH: "@elizaos/plugin-repoprompt",
  CLAUDE_CODE_WORKBENCH_ENABLED: "@elizaos/plugin-claude-code-workbench",
};

const FEATURE_PLUGINS: Record<string, string> = {
  browser: "@elizaos/plugin-browser",
  cua: "@elizaos/plugin-cua",
  obsidian: "@elizaos/plugin-obsidian",
  cron: "@elizaos/plugin-cron",
  shell: "@elizaos/plugin-shell",
  imageGen: "@elizaos/plugin-image-generation",
  tts: "@elizaos/plugin-tts",
  stt: "@elizaos/plugin-stt",
  agentSkills: "@elizaos/plugin-agent-skills",
  // directives: "@elizaos/plugin-directives", // not yet ready — package doesn't exist
  commands: "@elizaos/plugin-commands",
  diagnosticsOtel: "@elizaos/plugin-diagnostics-otel",
  webhooks: "@elizaos/plugin-webhooks",
  gmailWatch: "@elizaos/plugin-gmail-watch",
  personality: "@elizaos/plugin-personality",
  experience: "@elizaos/plugin-experience",
  form: "@elizaos/plugin-form",
  x402: "@elizaos/plugin-x402",
  // Media generation plugins
  fal: "@elizaos/plugin-fal",
  suno: "@elizaos/plugin-suno",
  vision: "@elizaos/plugin-vision",
  computeruse: "@elizaos/plugin-computeruse",
  repoprompt: "@elizaos/plugin-repoprompt",
  claudeCodeWorkbench: "@elizaos/plugin-claude-code-workbench",
};

export function isConnectorConfigured(
  connectorName: string,
  connectorConfig: unknown,
): boolean {
  if (!connectorConfig || typeof connectorConfig !== "object") {
    return false;
  }
  const config = connectorConfig as Record<string, unknown>;
  if (config.enabled === false) {
    return false;
  }
  if (config.botToken || config.token || config.apiKey) {
    return true;
  }

  const hasEnabledSignalAccount =
    connectorName === "signal" &&
    typeof config.accounts === "object" &&
    config.accounts !== null &&
    Object.values(config.accounts as Record<string, unknown>).some(
      (account) => {
        if (!account || typeof account !== "object") return false;
        const accountConfig = account as Record<string, unknown>;
        if (accountConfig.enabled === false) return false;
        return Boolean(
          accountConfig.authDir ||
            accountConfig.account ||
            accountConfig.httpUrl ||
            accountConfig.httpHost ||
            accountConfig.httpPort ||
            accountConfig.cliPath,
        );
      },
    );

  if (hasEnabledSignalAccount) {
    return true;
  }

  switch (connectorName) {
    case "bluebubbles":
      return Boolean(config.serverUrl && config.password);
    case "imessage":
      return Boolean(config.cliPath);
    case "signal":
      return Boolean(
        config.authDir ||
          config.account ||
          config.httpUrl ||
          config.httpHost ||
          config.httpPort ||
          config.cliPath,
      );
    case "whatsapp":
      // authState/sessionPath: legacy field names
      // authDir: Baileys multi-file auth state directory (WhatsAppAccountSchema)
      // accounts: at least one account with authDir set and not explicitly disabled
      return Boolean(
        config.authState ||
          config.sessionPath ||
          config.authDir ||
          (config.accounts &&
            typeof config.accounts === "object" &&
            Object.values(config.accounts as Record<string, unknown>).some(
              (account) => {
                if (!account || typeof account !== "object") return false;
                const acc = account as Record<string, unknown>;
                if (acc.enabled === false) return false;
                return Boolean(acc.authDir);
              },
            )),
      );
    case "retake":
      return Boolean(config.accessToken || config.enabled === true);
    case "twitch":
      return Boolean(
        config.accessToken || config.clientId || config.enabled === true,
      );
    default:
      return false;
  }
}

export function isStreamingDestinationConfigured(
  destName: string,
  destConfig: unknown,
): boolean {
  if (!destConfig || typeof destConfig !== "object") return false;
  const config = destConfig as Record<string, unknown>;
  if (config.enabled === false) return false;

  switch (destName) {
    case "retake":
      return Boolean(config.accessToken || config.enabled === true);
    case "twitch":
      return Boolean(config.streamKey || config.enabled === true);
    case "youtube":
      return Boolean(config.streamKey || config.enabled === true);
    case "customRtmp":
      return Boolean(config.rtmpUrl && config.rtmpKey);
    case "pumpfun":
      return Boolean(config.streamKey && config.rtmpUrl);
    case "x":
      return Boolean(config.streamKey && config.rtmpUrl);
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

/** Safely extract `agents.defaults.subscriptionProvider` from an untyped config. */
function getSubscriptionProvider(config: unknown): string | undefined {
  if (typeof config !== "object" || config === null) return undefined;
  const agents = (config as Record<string, unknown>).agents;
  if (typeof agents !== "object" || agents === null) return undefined;
  const defaults = (agents as Record<string, unknown>).defaults;
  if (typeof defaults !== "object" || defaults === null) return undefined;
  const provider = (defaults as Record<string, unknown>).subscriptionProvider;
  return typeof provider === "string" ? provider : undefined;
}

export function applyPluginAutoEnable(
  params: ApplyPluginAutoEnableParams,
): ApplyPluginAutoEnableResult {
  const { config, env } = params;
  const changes: string[] = [];
  const updatedConfig = structuredClone(config) as ElizaConfig;

  if (updatedConfig.plugins?.enabled === false) {
    return { config: updatedConfig, changes };
  }

  updatedConfig.plugins = updatedConfig.plugins ?? {};
  const pluginsConfig = updatedConfig.plugins;
  pluginsConfig.allow = pluginsConfig.allow ?? [];
  pluginsConfig.entries = pluginsConfig.entries ?? {};

  // Connectors (also check legacy `channels` key for backward compat)
  const connectors = updatedConfig.connectors ?? updatedConfig.channels;
  if (connectors) {
    for (const [connectorName, connectorConfig] of Object.entries(connectors)) {
      const pluginName = CONNECTOR_PLUGINS[connectorName];
      if (!pluginName) continue;
      if (!isConnectorConfigured(connectorName, connectorConfig)) continue;
      if (pluginsConfig.entries[connectorName]?.enabled === false) continue;
      addToAllowlist(
        pluginsConfig.allow,
        pluginName,
        connectorName,
        changes,
        `connector: ${connectorName}`,
      );
    }
  }

  // Streaming destinations
  const streaming = (updatedConfig as Record<string, unknown>).streaming as
    | Record<string, unknown>
    | undefined;
  if (streaming) {
    for (const [destName, destConfig] of Object.entries(streaming)) {
      if (destName === "activeDestination") continue; // skip meta field
      const pluginName = STREAMING_PLUGINS[destName];
      if (!pluginName) continue;
      if (!isStreamingDestinationConfigured(destName, destConfig)) continue;
      // Derive short ID from the package name (e.g. "@elizaos/plugin-twitch-streaming" → "twitch-streaming")
      const shortId = pluginName.includes("/plugin-")
        ? pluginName.slice(
            pluginName.lastIndexOf("/plugin-") + "/plugin-".length,
          )
        : destName;
      if (pluginsConfig.entries[shortId]?.enabled === false) continue;
      addToAllowlist(
        pluginsConfig.allow,
        pluginName,
        shortId,
        changes,
        `streaming: ${destName}`,
      );
    }
  }

  // Auth profiles
  if (updatedConfig.auth?.profiles) {
    for (const [profileKey, profile] of Object.entries(
      updatedConfig.auth.profiles,
    )) {
      const provider = profile.provider;
      if (!provider) continue;
      const pluginName = PROVIDER_PLUGINS[provider];
      if (!pluginName) continue;
      addToAllowlist(
        pluginsConfig.allow,
        pluginName,
        provider,
        changes,
        `auth profile: ${profileKey}`,
      );
    }
  }

  // Subscription provider — when a subscription is configured, force-enable
  // the corresponding provider plugin so the user doesn't need to manually
  // toggle entries.  This takes priority over explicit `enabled: false` for
  // the subscription's own plugin because the user deliberately connected
  // the subscription.
  const subscriptionProvider = getSubscriptionProvider(updatedConfig);
  const subscriptionPluginId =
    typeof subscriptionProvider === "string"
      ? SUBSCRIPTION_PROVIDER_MAP[
          subscriptionProvider as keyof typeof SUBSCRIPTION_PROVIDER_MAP
        ]
      : undefined;
  if (subscriptionPluginId) {
    const pluginName = PROVIDER_PLUGINS[subscriptionPluginId];
    if (pluginName) {
      // Force-enable the subscription plugin (override enabled: false)
      pluginsConfig.entries[subscriptionPluginId] = {
        ...pluginsConfig.entries[subscriptionPluginId],
        enabled: true,
      };
      addToAllowlist(
        pluginsConfig.allow,
        pluginName,
        subscriptionPluginId,
        changes,
        `subscription: ${subscriptionProvider}`,
      );
    }
  }

  // Env var API keys
  for (const [envKey, pluginName] of Object.entries(AUTH_PROVIDER_PLUGINS)) {
    const envValue = env[envKey];
    if (!envValue || typeof envValue !== "string" || envValue.trim() === "")
      continue;
    const pluginId = pluginName.includes("/plugin-")
      ? pluginName.slice(pluginName.lastIndexOf("/plugin-") + "/plugin-".length)
      : pluginName;
    if (pluginsConfig.entries[pluginId]?.enabled === false) continue;
    addToAllowlist(
      pluginsConfig.allow,
      pluginName,
      pluginId,
      changes,
      `env: ${envKey}`,
    );
  }

  // Feature flags
  if (updatedConfig.features) {
    for (const [featureName, featureConfig] of Object.entries(
      updatedConfig.features,
    )) {
      const pluginName = FEATURE_PLUGINS[featureName];
      if (!pluginName) continue;
      const isEnabled =
        featureConfig === true ||
        (typeof featureConfig === "object" &&
          featureConfig !== null &&
          featureConfig.enabled !== false);
      if (!isEnabled) continue;
      const pluginId = pluginName.includes("/plugin-")
        ? pluginName.slice(
            pluginName.lastIndexOf("/plugin-") + "/plugin-".length,
          )
        : pluginName;
      if (pluginsConfig.entries[pluginId]?.enabled === false) continue;
      addToAllowlist(
        pluginsConfig.allow,
        pluginName,
        pluginId,
        changes,
        `feature: ${featureName}`,
      );
    }
  }

  // Hooks: webhooks + gmail
  const hooksConfig = updatedConfig.hooks;
  if (hooksConfig && hooksConfig.enabled !== false && hooksConfig.token) {
    const webhooksPlugin = FEATURE_PLUGINS.webhooks;
    if (webhooksPlugin) {
      addToAllowlist(
        pluginsConfig.allow,
        webhooksPlugin,
        webhooksPlugin.replace("@elizaos/plugin-", ""),
        changes,
        "hooks.token",
      );
    }
  }
  if (hooksConfig) {
    const gmailConfig = hooksConfig.gmail;
    if (gmailConfig?.account?.trim()) {
      const gmailPlugin = FEATURE_PLUGINS.gmailWatch;
      if (gmailPlugin) {
        addToAllowlist(
          pluginsConfig.allow,
          gmailPlugin,
          gmailPlugin.replace("@elizaos/plugin-", ""),
          changes,
          "hooks.gmail.account",
        );
      }
    }
  }

  // Media generation plugins
  const mediaConfig = updatedConfig.media;
  if (mediaConfig) {
    // Image generation - FAL provider
    if (
      mediaConfig.image?.enabled !== false &&
      mediaConfig.image?.mode === "own-key" &&
      mediaConfig.image?.provider === "fal"
    ) {
      const falPlugin = FEATURE_PLUGINS.fal;
      if (falPlugin) {
        addToAllowlist(
          pluginsConfig.allow,
          falPlugin,
          "fal",
          changes,
          "media.image.provider=fal",
        );
      }
    }

    // Video generation - FAL provider
    if (
      mediaConfig.video?.enabled !== false &&
      mediaConfig.video?.mode === "own-key" &&
      mediaConfig.video?.provider === "fal"
    ) {
      const falPlugin = FEATURE_PLUGINS.fal;
      if (falPlugin) {
        addToAllowlist(
          pluginsConfig.allow,
          falPlugin,
          "fal",
          changes,
          "media.video.provider=fal",
        );
      }
    }

    // Audio/Music generation - Suno provider
    if (
      mediaConfig.audio?.enabled !== false &&
      mediaConfig.audio?.mode === "own-key" &&
      mediaConfig.audio?.provider === "suno"
    ) {
      const sunoPlugin = FEATURE_PLUGINS.suno;
      if (sunoPlugin) {
        addToAllowlist(
          pluginsConfig.allow,
          sunoPlugin,
          "suno",
          changes,
          "media.audio.provider=suno",
        );
      }
    }

    // Vision - enable vision plugin when configured
    if (mediaConfig.vision?.enabled !== false && mediaConfig.vision?.provider) {
      const visionPlugin = FEATURE_PLUGINS.vision;
      if (visionPlugin) {
        addToAllowlist(
          pluginsConfig.allow,
          visionPlugin,
          "vision",
          changes,
          `media.vision.provider=${mediaConfig.vision.provider}`,
        );
      }
    }
  }

  return { config: updatedConfig, changes };
}
