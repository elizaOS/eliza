/**
 * Plugin name collection and validation.
 *
 * Determines which plugin packages should be loaded based on config,
 * environment variables, feature flags, and provider precedence rules.
 *
 * When callers pass a {@link PluginLoadReasons} map, the first source that
 * added each package is recorded so `resolvePlugins` (`plugin-resolver.ts`)
 * can explain optional load failures (config vs env vs feature flag).
 *
 * Extracted from eliza.ts to reduce file size.
 *
 * @module plugin-collector
 */
import {
  hasExplicitCanonicalRuntimeConfig,
  isAndroidMobile,
  isMobilePlatform,
  migrateLegacyRuntimeConfig,
  type ResolvedElizaCloudTopology,
  resolveDeploymentTargetInConfig,
  resolveElizaCloudTopology,
  resolveServiceRoutingInConfig,
} from "@elizaos/shared";
import type { ElizaConfig } from "../config/config.js";
import {
  CORE_PLUGINS,
  ELIZAOS_ANDROID_CORE_PLUGINS,
  MOBILE_CORE_PLUGINS,
  OPTIONAL_CORE_PLUGINS,
} from "./core-plugins.js";

const OPTIONAL_CORE_PLUGIN_NAMES = new Set<string>(OPTIONAL_CORE_PLUGINS);

/**
 * Agent orchestrator ships as the standalone @elizaos/plugin-agent-orchestrator package;
 * Eliza loads it via STATIC_ELIZA_PLUGINS["agent-orchestrator"].
 */
function orchestratorCompatPluginRequested(config: ElizaConfig): boolean {
  const agentEntry = config.agents?.list?.[0];
  const fromEntry = agentEntry?.agentOrchestrator;
  const fromDefaults = config.agents?.defaults?.agentOrchestrator;
  if (typeof fromEntry === "boolean") {
    return fromEntry;
  }
  if (typeof fromDefaults === "boolean") {
    return fromDefaults;
  }
  const raw = process.env.ELIZA_AGENT_ORCHESTRATOR?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "no") {
    return false;
  }
  return raw === "1" || raw === "true" || raw === "yes";
}

function isElizaOsAndroidRuntime(): boolean {
  return (
    isAndroidMobile() &&
    process.env.ELIZA_LOCAL_LLAMA?.trim().toLowerCase() === "1"
  );
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Legacy package names that were merged or renamed. Config allow-lists and
 * `plugins.installs` may still reference the old id.
 */
const PLUGIN_PACKAGE_ALIASES: Readonly<Record<string, string>> = {
  "@elizaos/plugin-coding-agent": "@elizaos/plugin-coding-tools",
};

export function resolvePluginPackageAlias(packageName: string): string {
  return PLUGIN_PACKAGE_ALIASES[packageName] ?? packageName;
}

function packageNameFromPluginConfigId(pluginId: string): string {
  if (pluginId.includes("/")) return pluginId;
  if (pluginId.startsWith("app-") || pluginId.startsWith("plugin-")) {
    return `@elizaos/${pluginId}`;
  }
  return `@elizaos/plugin-${pluginId}`;
}

function isTruthyCloudEnvValue(raw: string | undefined): boolean {
  if (!raw) return false;
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

/** Maps Eliza channel names to plugin package names. */
export const CHANNEL_PLUGIN_MAP: Readonly<Record<string, string>> = {
  bluebubbles: "@elizaos/plugin-bluebubbles",
  discord: "@elizaos/plugin-discord",
  discordLocal: "@elizaos/plugin-discord-local",
  telegram: "@elizaos/plugin-telegram",
  slack: "@elizaos/plugin-slack",
  x: "@elizaos/plugin-x",
  // Backward-compat alias: legacy "twitter" channel resolves to plugin-x.
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

/** Maps environment variable names to model-provider plugin packages. */
export const PROVIDER_PLUGIN_MAP: Readonly<Record<string, string>> = {
  ANTHROPIC_API_KEY: "@elizaos/plugin-anthropic",
  OPENAI_API_KEY: "@elizaos/plugin-openai",
  GEMINI_API_KEY: "@elizaos/plugin-google-genai",
  GOOGLE_API_KEY: "@elizaos/plugin-google-genai",
  GOOGLE_GENERATIVE_AI_API_KEY: "@elizaos/plugin-google-genai",
  GROQ_API_KEY: "@elizaos/plugin-groq",
  XAI_API_KEY: "@elizaos/plugin-xai",
  OPENROUTER_API_KEY: "@elizaos/plugin-openrouter",
  DEEPSEEK_API_KEY: "@elizaos/plugin-deepseek",
  MISTRAL_API_KEY: "@elizaos/plugin-mistral",
  TOGETHER_API_KEY: "@elizaos/plugin-together",
  AI_GATEWAY_API_KEY: "@elizaos/plugin-vercel-ai-gateway",
  AIGATEWAY_API_KEY: "@elizaos/plugin-vercel-ai-gateway",
  OLLAMA_BASE_URL: "@elizaos/plugin-ollama",
  ZAI_API_KEY: "@homunculuslabs/plugin-zai",
  // ElizaCloud — loaded when API key is present OR cloud is explicitly enabled
  ELIZAOS_CLOUD_API_KEY: "@elizaos/plugin-elizacloud",
  ELIZAOS_CLOUD_ENABLED: "@elizaos/plugin-elizacloud",
};

const LOCAL_MODEL_PROVIDER_PLUGINS = new Set<string>([
  "@elizaos/plugin-ollama",
  "@elizaos/plugin-local-ai",
]);

const REMOTE_MODEL_PROVIDER_PLUGINS = new Set(
  Object.values(PROVIDER_PLUGIN_MAP).filter(
    (pluginName) =>
      pluginName !== "@elizaos/plugin-elizacloud" &&
      !LOCAL_MODEL_PROVIDER_PLUGINS.has(pluginName),
  ),
);

/**
 * Optional feature plugins keyed by feature name.
 *
 * Mappings here support short IDs in allow-lists and feature toggles.
 * Keep this map in sync with optional plugin registration and tests.
 */
export const OPTIONAL_PLUGIN_MAP: Readonly<Record<string, string>> = {
  // ── Wallet plugins ─────────────────────────────────────────────────
  // These short ids are what plugin-auto-enable.ts writes into
  // `plugins.allow` when EVM_PRIVATE_KEY / SOLANA_PRIVATE_KEY are
  // present in process.env. Without entries here, collectPluginNames()
  // would fall through to loading the short id as a literal package
  // name (`import("evm")`), which silently fails inside the loader's
  // error boundary — short ids must resolve to real package names or optional
  // plugins silently fail inside the loader. Keep in sync with AUTH_PROVIDER_PLUGINS
  // in packages/shared/src/config/plugin-auto-enable-engine.ts.
  evm: "@elizaos/plugin-wallet",
  solana: "@elizaos/plugin-wallet",
  wallet: "@elizaos/plugin-wallet",
  // Coding tools — persisted user configs may carry the legacy "coding-agent"
  // short ID (the plugin was renamed to plugin-coding-tools). Map both forms
  // so the resolver doesn't try to load a non-existent package.
  "coding-agent": "@elizaos/plugin-coding-tools",
  codingAgent: "@elizaos/plugin-coding-tools",
  "coding-tools": "@elizaos/plugin-coding-tools",
  codingTools: "@elizaos/plugin-coding-tools",
  /** Unified wallet (canonical actions + providers — incremental migration). */
  agent_wallet: "@elizaos/plugin-wallet",
  "agent-wallet": "@elizaos/plugin-wallet",
  /** Browser plugin: workspace browser + Chrome/Safari companion bridge. Replaces `@elizaos/app-browser` and `@elizaos/plugin-browser-bridge`; aliases here so short IDs in plugins.allow and config.features still resolve. */
  browser: "@elizaos/plugin-browser",
  "app-browser": "@elizaos/plugin-browser",
  appBrowser: "@elizaos/plugin-browser",
  "eliza-browser": "@elizaos/plugin-browser",
  elizaBrowser: "@elizaos/plugin-browser",
  "browser-bridge": "@elizaos/plugin-browser",
  browserBridge: "@elizaos/plugin-browser",
  /** Native Polymarket app runtime plugin. */
  polymarket: "@elizaos/app-polymarket",
  "app-polymarket": "@elizaos/app-polymarket",
  appPolymarket: "@elizaos/app-polymarket",
  vision: "@elizaos/plugin-vision",
  elizacloud: "@elizaos/plugin-elizacloud",
  selfcontrol: "@elizaos/app-lifeops",
  cua: "@elizaos/plugin-cua",
  computeruse: "@elizaos/plugin-computeruse",
  obsidian: "@elizaos/plugin-obsidian",
  repoprompt: "@elizaos/plugin-repoprompt",
  repoPrompt: "@elizaos/plugin-repoprompt",
  bluebubbles: "@elizaos/plugin-bluebubbles",
  discordLocal: "@elizaos/plugin-discord-local",
  x402: "@elizaos/plugin-x402",
  // plugin-manager, secrets (SECRETS), trust: now built-in core capabilities
  // Enable via ENABLE_PLUGIN_MANAGER, ENABLE_SECRETS_MANAGER, ENABLE_TRUST
  streaming: "@elizaos/plugin-streaming",
  form: "@elizaos/plugin-form",
  // Steward wallet plugin — short ID used by auto-enable
  "stwd-eliza-plugin": "@stwd/eliza-plugin",
};

// ---------------------------------------------------------------------------
// Main function
// ---------------------------------------------------------------------------

/**
 * First-winning provenance for each package name in the load set — e.g.
 * `plugins.allow[...]`, `env: SOLANA_PRIVATE_KEY`, `CORE_PLUGINS`.
 * {@link collectPluginNames} fills this when the optional `reasons` map is passed.
 *
 * **Why:** Optional plugins often fail with "Cannot find module"; without the
 * source, operators assume the framework is broken instead of fixing config/env.
 */
export type PluginLoadReasons = Map<string, string>;

/**
 * Collect plugin package names to load from config, env, feature flags, and
 * connector-derived allow-list mutations.
 *
 * @param reasons - When set, records the **first** reason each name was added
 *   (subsequent adds for the same name are ignored). Used by `resolvePlugins`
 *   to annotate benign optional load failures.
 *
 * @internal Exported for testing.
 */
export function collectPluginNames(
  config: ElizaConfig,
  reasons?: PluginLoadReasons,
): Set<string> {
  const legacyLocalOnlyInference =
    config.cloud?.inferenceMode === "local" ||
    config.cloud?.services?.inference === false;
  migrateLegacyRuntimeConfig(config as Record<string, unknown>);
  const deploymentTarget = resolveDeploymentTargetInConfig(
    config as Record<string, unknown>,
  );
  const serviceRouting = resolveServiceRoutingInConfig(
    config as Record<string, unknown>,
  );
  const shellPluginDisabled = config.features?.shellEnabled === false;
  const localEmbeddingsExplicitlyDisabled = (() => {
    const raw = process.env.ELIZA_DISABLE_LOCAL_EMBEDDINGS;
    if (!raw) return false;
    const normalized = raw.trim().toLowerCase();
    return normalized === "1" || normalized === "true" || normalized === "yes";
  })();
  const cloudTopology = resolveElizaCloudTopology(
    config as Record<string, unknown>,
  );
  const hasCanonicalRuntimeConfig = hasExplicitCanonicalRuntimeConfig(
    config as Record<string, unknown>,
  );
  const isCloudContainer = process.env.ELIZA_CLOUD_PROVISIONED === "1";
  const cloudExplicitlyDisabled = config.cloud?.enabled === false;
  // `ELIZA_LOCAL_LLAMA=1` is the AOSP / on-device signal that the in-process
  // llama.cpp loader is wired up and should be available as a routable
  // provider. It does NOT mean "strip every other provider": subscription
  // accounts (anthropic-subscription, openai-codex) and API-key cloud
  // plugins must keep loading so the user can route slots to them.
  // The local handler already registers at priority -1 (see
  // ensure-local-inference-handler.ts), so cloud/direct providers win when
  // the user has them configured, and local fills in otherwise.
  const localOnlyInference =
    legacyLocalOnlyInference ||
    (cloudExplicitlyDisabled &&
      deploymentTarget.runtime === "local" &&
      !serviceRouting?.llmText);
  const cloudPluginRequestedByEnv =
    !hasCanonicalRuntimeConfig &&
    !cloudExplicitlyDisabled &&
    (Boolean(process.env.ELIZAOS_CLOUD_API_KEY?.trim()) ||
      isTruthyCloudEnvValue(process.env.ELIZAOS_CLOUD_ENABLED));
  const cloudEffectivelyEnabled =
    resolveCloudPluginRequirement(cloudTopology, cloudPluginRequestedByEnv) ||
    isCloudContainer;
  // cloudHandlesInference gates whether the cloud plugin *replaces* direct
  // provider plugins for model calls.  Cloud containers that go through the
  // steward proxy (OPENAI_BASE_URL → host.docker.internal) need plugin-openai
  // to stay loaded, so only claim inference when the topology explicitly says
  // so OR the container has a direct cloud API key for elizacloud inference.
  const cloudHandlesInference =
    cloudTopology.services.inference ||
    (isCloudContainer && Boolean(process.env.ELIZAOS_CLOUD_API_KEY?.trim()));
  const _configEnv = config.env as
    | (Record<string, unknown> & { vars?: Record<string, unknown> })
    | undefined;
  const pluginEntries = (config.plugins as Record<string, unknown> | undefined)
    ?.entries as Record<string, { enabled?: boolean }> | undefined;

  const isPluginExplicitlyDisabled = (pluginPackageName: string): boolean => {
    const marker = "/plugin-";
    const markerIndex = pluginPackageName.lastIndexOf(marker);
    const pluginId =
      markerIndex >= 0
        ? pluginPackageName.slice(markerIndex + marker.length)
        : pluginPackageName;
    return pluginEntries?.[pluginId]?.enabled === false;
  };

  const providerPluginIdSet = new Set(
    Object.values(PROVIDER_PLUGIN_MAP).map((pluginPackageName) => {
      const marker = "/plugin-";
      const markerIndex = pluginPackageName.lastIndexOf(marker);
      return markerIndex >= 0
        ? pluginPackageName.slice(markerIndex + marker.length)
        : pluginPackageName;
    }),
  );
  const explicitProviderEntries = Object.entries(pluginEntries ?? {}).filter(
    ([pluginId]) => providerPluginIdSet.has(pluginId),
  );
  const hasExplicitEnabledProvider = explicitProviderEntries.some(
    ([, entry]) => entry?.enabled === true,
  );

  // Allow-list entries are additive (extra plugins), not exclusive.
  const allowList = config.plugins?.allow;
  // On mobile (ELIZA_PLATFORM=android|ios) the desktop core list pulls in
  // ~10 plugins that depend on subprocesses (n8n, signal-cli), platform
  // launchers (/usr/bin/open, osascript, xdg-open), or PTY tooling — all
  // unavailable in the app sandbox. Substitute the curated mobile-safe set.
  const onMobile = isMobilePlatform();
  const onElizaOsAndroid = isElizaOsAndroidRuntime();
  const seedCorePlugins = onMobile ? MOBILE_CORE_PLUGINS : CORE_PLUGINS;
  const pluginsToLoad = new Set<string>(seedCorePlugins);
  const track = (name: string, reason: string) => {
    if (reasons && !reasons.has(name)) reasons.set(name, reason);
  };
  for (const core of seedCorePlugins) {
    track(core, onMobile ? "MOBILE_CORE_PLUGINS" : "CORE_PLUGINS");
  }
  // ElizaOS-only: add the system-surface overlay app plugins (WiFi,
  // Contacts, Phone). These wrap privileged Android system APIs available
  // only in the custom AOSP build, not in the stock Android APK. The overlay
  // UI registration happens in the renderer via @elizaos/app-*/register
  // imports — these are the *runtime* plugin halves that expose actions
  // to the agent for `Connect to wifi`, `Find contact`, `Call so-and-so`.
  if (onElizaOsAndroid) {
    for (const name of ELIZAOS_ANDROID_CORE_PLUGINS) {
      pluginsToLoad.add(name);
      track(name, "ELIZAOS_ANDROID_CORE_PLUGINS");
    }
  }
  // Agent orchestrator depends on PTY / coding-swarm subprocesses (none of
  // which exist on Android / iOS), so always skip it on mobile regardless of
  // the stored ELIZA_AGENT_ORCHESTRATOR / config preference.
  if (!onMobile && orchestratorCompatPluginRequested(config)) {
    pluginsToLoad.add("agent-orchestrator");
    track(
      "agent-orchestrator",
      "agent-orchestrator (@elizaos/plugin-agent-orchestrator)",
    );
  }
  if (localEmbeddingsExplicitlyDisabled) {
    pluginsToLoad.delete("@elizaos/plugin-local-embedding");
  }

  // Allow list is additive — extra plugins on top of auto-detection,
  // not an exclusive whitelist that blocks everything else.
  if (allowList && allowList.length > 0) {
    for (const item of allowList) {
      // Normalize short IDs (e.g. "openai" → "@elizaos/plugin-openai") the
      // same way plugins.entries does — addToAllowlist() pushes both the
      // short ID and the full package name, so bare short IDs must be
      // expanded to avoid importing the raw SDK package (e.g. "openai").
      const pluginName = resolvePluginPackageAlias(
        CHANNEL_PLUGIN_MAP[item] ??
          OPTIONAL_PLUGIN_MAP[item] ??
          packageNameFromPluginConfigId(item),
      );
      pluginsToLoad.add(pluginName);
      track(pluginName, `plugins.allow[${JSON.stringify(item)}]`);
    }
  }

  // Connector plugins — load when connector has config entries
  // Prefer config.connectors, fall back to config.channels for backward compatibility
  const connectors =
    config.connectors ??
    ((config as Record<string, unknown>).channels as Record<string, unknown>) ??
    {};
  for (const [channelName, channelConfig] of Object.entries(connectors)) {
    if (
      !channelConfig ||
      typeof channelConfig !== "object" ||
      Array.isArray(channelConfig)
    ) {
      continue;
    }
    if ((channelConfig as Record<string, unknown>).enabled === false) {
      continue;
    }
    const pluginName = CHANNEL_PLUGIN_MAP[channelName];
    if (pluginName) {
      pluginsToLoad.add(pluginName);
      track(pluginName, `connectors.${channelName}`);
    }
  }

  // Model-provider plugins — load when env key is present
  for (const [envKey, pluginName] of Object.entries(PROVIDER_PLUGIN_MAP)) {
    if (
      envKey === "ELIZAOS_CLOUD_API_KEY" ||
      envKey === "ELIZAOS_CLOUD_ENABLED"
    ) {
      continue;
    }
    if (isPluginExplicitlyDisabled(pluginName)) {
      continue;
    }
    if (hasExplicitEnabledProvider) {
      const marker = "/plugin-";
      const markerIndex = pluginName.lastIndexOf(marker);
      const pluginId =
        markerIndex >= 0
          ? pluginName.slice(markerIndex + marker.length)
          : pluginName;
      if (pluginEntries?.[pluginId]?.enabled !== true) {
        continue;
      }
    }
    if (process.env[envKey]?.trim()) {
      pluginsToLoad.add(pluginName);
      track(pluginName, `env: ${envKey}`);
    }
  }

  const applyProviderPrecedence = (): void => {
    if (localOnlyInference) {
      pluginsToLoad.delete("@elizaos/plugin-elizacloud");
      for (const pluginName of REMOTE_MODEL_PROVIDER_PLUGINS) {
        pluginsToLoad.delete(pluginName);
      }
      return;
    }

    if (cloudEffectivelyEnabled) {
      pluginsToLoad.add("@elizaos/plugin-elizacloud");

      if (cloudHandlesInference) {
        const directProviders = new Set(Object.values(PROVIDER_PLUGIN_MAP));
        directProviders.delete("@elizaos/plugin-elizacloud");
        for (const p of directProviders) {
          pluginsToLoad.delete(p);
        }
        return;
      }
      return;
    }

    // Cloud is not part of the resolved topology — remove it even though
    // it is listed in CORE_PLUGINS so stale env/config does not hijack
    // provider selection after the user switches away.
    pluginsToLoad.delete("@elizaos/plugin-elizacloud");
  };

  // Apply once before additive plugin-entry/feature paths.
  applyProviderPrecedence();

  // Optional feature plugins from config.plugins.entries
  const pluginsConfig = config.plugins as
    | Record<string, Record<string, unknown>>
    | undefined;
  if (pluginsConfig?.entries) {
    for (const [key, entry] of Object.entries(pluginsConfig.entries)) {
      if (!entry || typeof entry !== "object") continue;
      // Connector keys (telegram, discord, etc.) must use CHANNEL_PLUGIN_MAP
      // so the correct variant loads.
      const pluginName = resolvePluginPackageAlias(
        CHANNEL_PLUGIN_MAP[key] ??
          OPTIONAL_PLUGIN_MAP[key] ??
          packageNameFromPluginConfigId(key),
      );
      const isOptionalCore = OPTIONAL_CORE_PLUGIN_NAMES.has(pluginName);
      const entryEnabled = (entry as Record<string, unknown>).enabled;
      const shouldAdd = isOptionalCore
        ? entryEnabled === true
        : entryEnabled !== false;
      if (shouldAdd) {
        pluginsToLoad.add(pluginName);
        track(pluginName, `plugins.entries["${key}"]`);
      }
    }
  }

  // Feature flags (config.features)
  const features = config.features;
  if (features && typeof features === "object") {
    for (const [featureName, featureValue] of Object.entries(features)) {
      const isEnabled =
        featureValue === true ||
        (typeof featureValue === "object" &&
          featureValue !== null &&
          (featureValue as Record<string, unknown>).enabled !== false);
      if (isEnabled) {
        const pluginName = OPTIONAL_PLUGIN_MAP[featureName];
        if (pluginName) {
          const resolved = resolvePluginPackageAlias(pluginName);
          pluginsToLoad.add(resolved);
          track(resolved, `features.${featureName}`);
        }
      }
    }
  }

  // x402 plugin — auto-load when config section enabled
  if (config.x402?.enabled) {
    pluginsToLoad.add("@elizaos/plugin-x402");
    track("@elizaos/plugin-x402", "config.x402.enabled");
  }

  // Opinion plugin — auto-load when API key is present.
  // NOT in PROVIDER_PLUGIN_MAP because it is a feature plugin, not a model
  // provider, and would be incorrectly removed during provider precedence.
  if (process.env.OPINION_API_KEY?.trim()) {
    pluginsToLoad.add("@elizaos/plugin-opinion");
    track("@elizaos/plugin-opinion", "env: OPINION_API_KEY");
  }

  // These are plugins that were installed via the plugin-manager at runtime
  // and tracked in eliza.json so they persist across restarts.
  const installs = config.plugins?.installs;
  if (installs && typeof installs === "object") {
    for (const [packageName, record] of Object.entries(installs)) {
      if (record && typeof record === "object") {
        const resolved = resolvePluginPackageAlias(packageName);
        pluginsToLoad.add(resolved);
        track(resolved, "plugins.installs");
      }
    }
  }

  // Re-apply provider precedence so later additive paths (entries, features,
  // installs) cannot accidentally re-introduce suppressed providers.
  applyProviderPrecedence();

  // Enforce feature gating last so allow-list entries cannot bypass it.
  if (shellPluginDisabled) {
    pluginsToLoad.delete("@elizaos/plugin-shell");
  }

  for (const pluginName of Array.from(pluginsToLoad)) {
    if (isPluginExplicitlyDisabled(pluginName)) {
      pluginsToLoad.delete(pluginName);
    }
  }

  // Mobile: restrict the final set to plugins that the bundled mobile runtime
  // can actually load — the mobile-core list plus model-provider plugins that
  // are statically imported in `runtime/eliza.ts`. Anything else (connector
  // plugins, feature plugins from `plugins.entries`, drop-in plugins from
  // `plugins.installs`) would force a dynamic `import("@elizaos/plugin-...")`
  // against a `node_modules` tree that does not ship in the APK.
  if (onMobile) {
    const mobileAllowed = new Set<string>([
      ...MOBILE_CORE_PLUGINS,
      ...(onElizaOsAndroid ? ELIZAOS_ANDROID_CORE_PLUGINS : []),
      "@elizaos/plugin-anthropic",
      "@elizaos/plugin-openai",
      "@elizaos/plugin-ollama",
      "@elizaos/plugin-elizacloud",
    ]);
    for (const pluginName of Array.from(pluginsToLoad)) {
      if (!mobileAllowed.has(pluginName)) {
        pluginsToLoad.delete(pluginName);
      }
    }
  }

  return pluginsToLoad;
}

function resolveCloudPluginRequirement(
  topology: ResolvedElizaCloudTopology,
  requestedByEnv: boolean,
): boolean {
  return topology.shouldLoadPlugin || requestedByEnv;
}
