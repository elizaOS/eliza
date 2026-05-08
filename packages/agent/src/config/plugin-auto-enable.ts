import type { Plugin } from "@elizaos/core";
import { SUBSCRIPTION_PROVIDER_MAP } from "../auth/types.js";
import { evmAutoEnableReasonFromCapability } from "../services/evm-signing-capability.js";
import type { ElizaConfig } from "./types.js";

export interface ApplyPluginAutoEnableResult {
  config: ElizaConfig;
  changes: string[];
}

export interface ApplyPluginAutoEnableParams {
  config: Partial<ElizaConfig>;
  env: NodeJS.ProcessEnv;
  /**
   * Already-loaded plugin instances. When provided, the function checks each
   * plugin's `autoEnable` declaration BEFORE falling back to the hardcoded maps.
   * This enables a gradual migration: plugins that self-declare their enable
   * conditions no longer need entries in the central map.
   */
  loadedPlugins?: Plugin[];
  /**
   * True when the runtime is hosted inside a Capacitor native shell
   * (iOS / Android). Mobile cannot spawn a local n8n sidecar via
   * `node:child_process`, so the n8n plugin is only auto-enabled when the
   * Eliza Cloud gateway is authenticated. Desktop / server / web leave this
   * undefined.
   */
  isNativePlatform?: boolean;
}

export const CONNECTOR_PLUGINS: Record<string, string> = {
  bluebubbles: "@elizaos/plugin-bluebubbles",
  telegram: "@elizaos/plugin-telegram",
  discord: "@elizaos/plugin-discord",
  discordLocal: "@elizaos/plugin-discord-local",
  slack: "@elizaos/plugin-slack",
  x: "@elizaos/plugin-x",
  // Backward-compat alias: legacy "twitter" connector key resolves to plugin-x.
  twitter: "@elizaos/plugin-x",
  // Internal connector built from src/plugins/whatsapp (not an npm package).
  whatsapp: "@elizaos/plugin-whatsapp",
  // Internal connector built from src/plugins/signal (not an npm package).
  signal: "@elizaos/plugin-signal",
  imessage: "@elizaos/plugin-imessage",
  farcaster: "@elizaos/plugin-farcaster",
  lens: "@elizaos/plugin-lens",
  msteams: "@elizaos/plugin-msteams",
  feishu: "@elizaos/plugin-feishu",
  matrix: "@elizaos/plugin-matrix",
  nostr: "@elizaos/plugin-nostr",
  blooio: "@elizaos/plugin-blooio",
  twitch: "@elizaos/plugin-twitch",
  mattermost: "@elizaos/plugin-mattermost",
  googlechat: "@elizaos/plugin-google-chat",
};

export const STREAMING_PLUGINS: Record<string, string> = {
  twitch: "@elizaos/plugin-streaming",
  youtube: "@elizaos/plugin-streaming",
  customRtmp: "@elizaos/plugin-streaming",
  pumpfun: "@elizaos/plugin-streaming",
  x: "@elizaos/plugin-streaming",
  rtmpSources: "@elizaos/plugin-streaming",
};

const PROVIDER_PLUGINS: Record<string, string> = {
  "google-antigravity": "@elizaos/plugin-google-antigravity",
  "google-genai": "@elizaos/plugin-google-genai",
  "vercel-ai-gateway": "@elizaos/plugin-vercel-ai-gateway",
  "codex-cli": "@elizaos/plugin-codex-cli",
  openai: "@elizaos/plugin-openai",
  anthropic: "@elizaos/plugin-anthropic",
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
  GOOGLE_API_KEY: "@elizaos/plugin-google-genai",
  GOOGLE_GENERATIVE_AI_API_KEY: "@elizaos/plugin-google-genai",
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
  CUA_API_KEY: "@elizaos/plugin-cua",
  CUA_HOST: "@elizaos/plugin-cua",
  OBSIDIAN_VAULT_PATH: "@elizaos/plugin-obsidian",
  OBSIDAN_VAULT_PATH: "@elizaos/plugin-obsidian",
  REPOPROMPT_CLI_PATH: "@elizaos/plugin-repoprompt",
  CLAUDE_CODE_WORKBENCH_ENABLED: "@elizaos/plugin-claude-code-workbench",
  // NOTE: EVM signing auto-enable is NOT via this map — see resolveEvmAutoEnableReason().
  SOLANA_PRIVATE_KEY: "@elizaos/plugin-wallet",
  LASTFM_API_KEY: "@elizaos/plugin-music-library",
  GENIUS_API_KEY: "@elizaos/plugin-music-library",
  THEAUDIODB_API_KEY: "@elizaos/plugin-music-library",
  SPOTIFY_CLIENT_ID: "@elizaos/plugin-music-library",
  SPOTIFY_CLIENT_SECRET: "@elizaos/plugin-music-library",
  RS_SDK_BOT_NAME: "@elizaos/app-2004scape",
  SHOPIFY_ACCESS_TOKEN: "@elizaos/plugin-shopify",
};

const FEATURE_PLUGINS: Record<string, string> = {
  browser: "@elizaos/plugin-browser",
  cua: "@elizaos/plugin-cua",
  obsidian: "@elizaos/plugin-obsidian",
  shell: "@elizaos/plugin-shell",
  executeCode: "@elizaos/plugin-executecode",
  imageGen: "@elizaos/plugin-image-generation",
  tts: "@elizaos/plugin-edge-tts",
  stt: "@elizaos/plugin-stt",
  agentSkills: "@elizaos/plugin-agent-skills",
  commands: "@elizaos/plugin-commands",
  diagnosticsOtel: "@elizaos/plugin-diagnostics-otel",
  webhooks: "@elizaos/plugin-webhooks",
  gmailWatch: "@elizaos/plugin-gmail-watch",
  form: "@elizaos/plugin-form",
  // personality is a built-in advanced capability
  x402: "@elizaos/plugin-x402",
  // Media generation plugins
  fal: "@elizaos/plugin-fal",
  suno: "@elizaos/plugin-suno",
  musicLibrary: "@elizaos/plugin-music-library",
  musicPlayer: "@elizaos/plugin-music-player",
  vision: "@elizaos/plugin-vision",
  computeruse: "@elizaos/plugin-computeruse",
  repoprompt: "@elizaos/plugin-repoprompt",
  claudeCodeWorkbench: "@elizaos/plugin-claude-code-workbench",
  rs2004scape: "@elizaos/app-2004scape",
};

const WALLET_PLUGIN_PACKAGE = "@elizaos/plugin-wallet";
const WALLET_PLUGIN_SHORT_ID = "wallet";

const STEWARD_ELIZA_PLUGIN_PACKAGE = "@stwd/eliza-plugin";
const STEWARD_ELIZA_PLUGIN_SHORT_ID = "stwd-eliza-plugin";

// Delegates to resolveEvmSigningCapability so wallet auto-enable and the
// wallet-capability UI agree on whether a signing path exists. A cloud address
// without signing (cloud-view-only) returns null — @elizaos/plugin-wallet must not load
// without a working signer.
function resolveEvmAutoEnableReason(env: NodeJS.ProcessEnv): string | null {
  return evmAutoEnableReasonFromCapability(env);
}

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
    case "discordLocal":
      return Boolean(config.clientId && config.clientSecret);
    case "imessage":
      return Boolean(
        config.enabled === true || config.cliPath || config.dbPath,
      );
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
    case "rtmpSources":
      return (
        Array.isArray(destConfig) &&
        destConfig.some((row) => {
          if (!row || typeof row !== "object") return false;
          const rec = row as Record<string, unknown>;
          const id = String(rec.id ?? "").trim();
          const url = String(rec.rtmpUrl ?? "").trim();
          const key = String(rec.rtmpKey ?? "").trim();
          return Boolean(id && url && key);
        })
      );
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
  let added = false;
  if (!allow.includes(shortId)) {
    allow.push(shortId);
    added = true;
  }
  if (pluginName !== shortId && !allow.includes(pluginName)) {
    // Keep the fully qualified package too so older collector paths and
    // external config consumers still work when they expect package names.
    allow.push(pluginName);
    added = true;
  }
  if (added) {
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

  const connectors = (updatedConfig.connectors ??
    (updatedConfig as Record<string, unknown>).channels ??
    {}) as Record<string, unknown>;
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
      // Derive short ID from the package name (e.g. "@elizaos/plugin-streaming" → "streaming")
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
  //
  // Exception: Anthropic subscriptions are restricted to the Claude Code
  // CLI by TOS.  Their tokens cannot be used by the runtime, so we must
  // NOT force-enable @elizaos/plugin-anthropic based on subscription alone.
  // A direct ANTHROPIC_API_KEY (set below via env-var detection) will still
  // enable the plugin if available.
  const subscriptionProvider = getSubscriptionProvider(updatedConfig);
  const subscriptionIsRuntimeApplicable =
    typeof subscriptionProvider === "string" &&
    subscriptionProvider !== "anthropic-subscription";
  const subscriptionPluginId = subscriptionIsRuntimeApplicable
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

  const evmAutoEnableReason = resolveEvmAutoEnableReason(env);

  if (env.ELIZA_AGENT_WALLET_AUTO_ENABLE !== "0") {
    const solanaKeyReason =
      typeof env.SOLANA_PRIVATE_KEY === "string" &&
      env.SOLANA_PRIVATE_KEY.trim().length > 0
        ? "env: SOLANA_PRIVATE_KEY"
        : null;
    const cloudStewardReason =
      env.ELIZA_CLOUD_PROVISIONED === "1" &&
      env.STEWARD_API_URL?.trim() &&
      env.STEWARD_AGENT_TOKEN?.trim()
        ? "cloud-provisioned Steward"
        : null;
    const agentWalletReason =
      evmAutoEnableReason ?? solanaKeyReason ?? cloudStewardReason;
    const walletExplicitlyDisabled =
      pluginsConfig.entries[WALLET_PLUGIN_SHORT_ID]?.enabled === false ||
      pluginsConfig.entries["agent-wallet"]?.enabled === false ||
      pluginsConfig.entries.evm?.enabled === false ||
      pluginsConfig.entries.solana?.enabled === false;
    if (agentWalletReason && !walletExplicitlyDisabled) {
      addToAllowlist(
        pluginsConfig.allow,
        WALLET_PLUGIN_PACKAGE,
        WALLET_PLUGIN_SHORT_ID,
        changes,
        agentWalletReason,
      );
    }
  }

  // Auto-enable @stwd/eliza-plugin when Steward API is configured.
  // This mirrors the desktop (app-core) path and ensures cloud containers get
  // StewardService + STEWARD_TRANSFER action registered with the runtime.
  if (
    env.STEWARD_API_URL?.trim() &&
    pluginsConfig.entries[STEWARD_ELIZA_PLUGIN_SHORT_ID]?.enabled !== false
  ) {
    addToAllowlist(
      pluginsConfig.allow,
      STEWARD_ELIZA_PLUGIN_PACKAGE,
      STEWARD_ELIZA_PLUGIN_SHORT_ID,
      changes,
      "env: STEWARD_API_URL",
    );
  }

  const cloudProvisioned = env.ELIZA_CLOUD_PROVISIONED === "1";
  if (
    cloudProvisioned &&
    pluginsConfig.entries["edge-tts"]?.enabled !== false
  ) {
    addToAllowlist(
      pluginsConfig.allow,
      "@elizaos/plugin-edge-tts",
      "edge-tts",
      changes,
      "cloud-provisioned voice output",
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

  // Heal entries→allow drift: anything user-enabled via plugins.entries should
  // also appear in the allowlist. Covers plugins that were toggled on via the
  // API before the entries↔allow sync existed, so the persisted config
  // stabilises after one boot instead of warning forever.
  for (const [entryId, entry] of Object.entries(pluginsConfig.entries)) {
    if (!entry || entry.enabled !== true) continue;
    const connectorPackage = CONNECTOR_PLUGINS[entryId];
    const featurePackage = FEATURE_PLUGINS[entryId];
    const pluginName =
      connectorPackage ?? featurePackage ?? `@elizaos/plugin-${entryId}`;
    addToAllowlist(
      pluginsConfig.allow,
      pluginName,
      entryId,
      changes,
      `entries: ${entryId}`,
    );
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

  // n8n workflow plugin — auto-enable when EITHER Eliza Cloud is authenticated
  // (cloud supplies N8N_HOST + N8N_API_KEY via its gateway) OR the local n8n
  // sidecar is permitted (config.n8n.localEnabled !== false, default true).
  // The authoritative boot-config shape is `config.n8n` (N8nConfig in
  // types.eliza.ts); the sidecar lifecycle writes `config.n8n.host` and
  // `config.n8n.apiKey` once ready. The plugin's init() refuses to activate
  // when neither is resolved, so this is safe to auto-enable eagerly.
  //
  // On mobile (iOS / Android), the local sidecar cannot spawn a child
  // process, so auto-enable is gated on `cloudAuthed` alone regardless of
  // `localEnabled`.
  {
    const n8nPluginName = "@elizaos/plugin-n8n-workflow";
    const n8nPluginId = "n8n-workflow";
    const n8nConfig = updatedConfig.n8n;
    const n8nMasterEnabled = n8nConfig?.enabled !== false;
    const cloudAuthed = Boolean(
      updatedConfig.cloud?.apiKey && updatedConfig.cloud?.enabled !== false,
    );
    // Default is "local sidecar allowed" — only disable if explicitly set to
    // false. Mobile forces this to false regardless of user setting.
    const localN8nEnabled =
      params.isNativePlatform === true
        ? false
        : n8nConfig?.localEnabled !== false;
    const n8nExplicitlyDisabled =
      pluginsConfig.entries[n8nPluginId]?.enabled === false;
    if (
      n8nMasterEnabled &&
      !n8nExplicitlyDisabled &&
      (cloudAuthed || localN8nEnabled)
    ) {
      addToAllowlist(
        pluginsConfig.allow,
        n8nPluginName,
        n8nPluginId,
        changes,
        cloudAuthed ? "cloud: n8n gateway" : "n8n.localEnabled",
      );
    }
  }

  // ── Self-declared autoEnable on loaded plugins ────────────────────────
  // When loadedPlugins are provided, check each plugin's autoEnable field.
  // This runs after the hardcoded maps so self-declared plugins can add to
  // the allow list without needing a central map entry.
  if (params.loadedPlugins) {
    applyPluginSelfDeclaredAutoEnable(
      params.loadedPlugins,
      updatedConfig,
      env,
      changes,
    );
  }

  return { config: updatedConfig, changes };
}

/**
 * Check loaded plugins for self-declared `autoEnable` conditions and add
 * matching ones to the config allow list.
 *
 * This is the data-driven counterpart to the hardcoded maps above. Plugins
 * that declare `autoEnable` on their Plugin object can be auto-enabled
 * without any central map entry.
 *
 * Can be called standalone (e.g., after a second-pass plugin resolution)
 * or implicitly via `applyPluginAutoEnable({ loadedPlugins })`.
 */
export function applyPluginSelfDeclaredAutoEnable(
  loadedPlugins: Plugin[],
  config: ElizaConfig,
  env: NodeJS.ProcessEnv,
  changes: string[],
): void {
  config.plugins = config.plugins ?? {};
  const pluginsConfig = config.plugins;
  pluginsConfig.allow = pluginsConfig.allow ?? [];

  const connectors = (config.connectors ??
    (config as Record<string, unknown>).channels ??
    {}) as Record<string, unknown>;

  for (const plugin of loadedPlugins) {
    if (!plugin.autoEnable) continue;
    const { envKeys, connectorKeys, shouldEnable } = plugin.autoEnable;

    // Derive a short ID from the plugin name for allow-list and entries lookup.
    // e.g. "@elizaos/plugin-telegram" → "telegram", "shopify" → "shopify"
    const pluginName = plugin.name;
    const shortId = pluginName.includes("/plugin-")
      ? pluginName.slice(pluginName.lastIndexOf("/plugin-") + "/plugin-".length)
      : pluginName;

    // Skip if explicitly disabled in config entries
    if (pluginsConfig.entries?.[shortId]?.enabled === false) continue;

    // Skip if already in the allow list (already enabled by hardcoded map or earlier pass)
    if (
      pluginsConfig.allow.includes(shortId) ||
      pluginsConfig.allow.includes(pluginName)
    ) {
      continue;
    }

    let enableReason: string | null = null;

    // Check env keys (OR — any match enables)
    if (envKeys?.length) {
      for (const key of envKeys) {
        const val = env[key];
        if (val && typeof val === "string" && val.trim() !== "") {
          enableReason = `self-declared env: ${key}`;
          break;
        }
      }
    }

    // Check connector keys (OR — any match enables)
    if (!enableReason && connectorKeys?.length) {
      for (const connectorName of connectorKeys) {
        const connectorConfig = connectors[connectorName];
        if (
          connectorConfig &&
          isConnectorConfigured(connectorName, connectorConfig)
        ) {
          enableReason = `self-declared connector: ${connectorName}`;
          break;
        }
      }
    }

    // Check custom predicate
    if (!enableReason && shouldEnable) {
      if (
        shouldEnable(
          env as Record<string, string | undefined>,
          config as Record<string, unknown>,
        )
      ) {
        enableReason = "self-declared shouldEnable predicate";
      }
    }

    if (enableReason) {
      addToAllowlist(
        pluginsConfig.allow,
        pluginName,
        shortId,
        changes,
        enableReason,
      );
    }
  }
}
