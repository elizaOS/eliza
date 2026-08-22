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
 * @module plugin-collector
 */
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  isGoogleChatConfigured,
  lifeOpsPassiveConnectorsSetting,
} from "@elizaos/core";
import channelPluginMap from "@elizaos/registry/first-party/channel-plugin-map.json" with {
  type: "json",
};
import providerPluginMap from "@elizaos/registry/first-party/provider-plugin-map.json" with {
  type: "json",
};
import shortIdPluginMap from "@elizaos/registry/first-party/short-id-plugin-map.json" with {
  type: "json",
};
import {
  getFirstRunProviderOption,
  hasExplicitCanonicalRuntimeConfig,
  isAndroidMobile,
  isMobilePlatform,
  migrateLegacyRuntimeConfig,
  normalizeFirstRunProviderId,
  type ResolvedElizaCloudTopology,
  readAliasedEnv,
  resolveDeploymentTargetInConfig,
  resolveElizaCloudTopology,
  resolveServiceRoutingInConfig,
} from "@elizaos/shared";
import type { ElizaConfig } from "../config/config.ts";
import {
  CORE_PLUGINS,
  ELIZAOS_ANDROID_CORE_PLUGINS,
  ELIZAOS_ANDROID_TERMINAL_PLUGINS,
  LEAN_CHAT_EXCLUDED_PLUGINS,
  LEAN_CHAT_PLUGINS,
  MOBILE_CORE_PLUGINS,
  MOBILE_MODEL_PROVIDER_PLUGINS,
  MOBILE_VIEW_PLUGINS,
  OPTIONAL_CORE_PLUGINS,
} from "./core-plugins.ts";

const OPTIONAL_CORE_PLUGIN_NAMES = new Set<string>(OPTIONAL_CORE_PLUGINS);
const STORE_BUILD_LOCAL_EXECUTION_PLUGINS = new Set<string>([
  "agent-orchestrator",
  "@elizaos/plugin-agent-orchestrator",
  "@elizaos/plugin-coding-tools",
]);
const requireFromPluginCollector = createRequire(import.meta.url);

function gitpathologistPackageAvailable(): boolean {
  try {
    requireFromPluginCollector.resolve(
      "@elizaos/plugin-gitpathologist/package.json",
    );
    return true;
  } catch {
    return false;
  }
}

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
  const raw = readAliasedEnv("ELIZA_AGENT_ORCHESTRATOR")?.toLowerCase();
  if (raw === "0" || raw === "false" || raw === "no") {
    return false;
  }
  if (raw === "1" || raw === "true" || raw === "yes") {
    return true;
  }
  // Dedicated cloud containers default the orchestrator ON: each agent owns a
  // hardened single-tenant VM, so its coding/orchestration surface should
  // match a local desktop agent instead of requiring a per-container env
  // opt-in. Explicit config/env opt-outs above still win, and lean-chat
  // containers force-drop it via LEAN_CHAT_EXCLUDED_PLUGINS regardless.
  if (readAliasedEnv("ELIZA_CLOUD_PROVISIONED") === "1") {
    return true;
  }
  return [
    "ELIZA_DEFAULT_AGENT_TYPE",
    "ELIZA_ACP_DEFAULT_AGENT",
    "ELIZA_AGENT_SELECTION_STRATEGY",
    "ELIZA_MAX_CONCURRENT_SPAWNS",
  ].some((key) => Boolean(process.env[key]?.trim()));
}

function isElizaOsAndroidRuntime(): boolean {
  return (
    isAndroidMobile() &&
    process.env.ELIZA_LOCAL_LLAMA?.trim().toLowerCase() === "1"
  );
}

/**
 * Gitpathologist ships as @elizaos/plugin-gitpathologist. Auto-loads when the
 * same env-resolved workspace the action will analyze looks like a git repo.
 * Users can explicitly opt out via ELIZA_GITPATHOLOGIST=0.
 */
function resolveGitpathologistRepoRoot(): string {
  const fromEnv = process.env.ELIZA_WORKSPACE_DIR;
  const cwd = fromEnv?.trim() ? fromEnv.trim() : process.cwd();
  return path.resolve(cwd);
}

function isUsableCloudApiKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  return (
    trimmed.length > 0 &&
    trimmed.toUpperCase() !== "[REDACTED]" &&
    !trimmed.startsWith("vault://")
  );
}

function gitpathologistRequested(config: ElizaConfig): boolean {
  const agentEntry = config.agents?.list?.[0];
  const fromEntry = agentEntry?.gitpathologist;
  const fromDefaults = config.agents?.defaults?.gitpathologist;
  if (typeof fromEntry === "boolean") return fromEntry;
  if (typeof fromDefaults === "boolean") return fromDefaults;
  const raw = process.env.ELIZA_GITPATHOLOGIST?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "no") return false;
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  return (
    existsSync(path.join(resolveGitpathologistRepoRoot(), ".git")) &&
    gitpathologistPackageAvailable()
  );
}

/**
 * Env kill-switch for the host-selected LifeOps owner-chat capability (#17023).
 * Config-level opt-out (`plugins.entries["personal-assistant"].enabled=false`)
 * is honored separately by the explicit-disable sweep in collectPluginNames.
 */
function personalAssistantDisabledByEnv(): boolean {
  const raw =
    process.env.ELIZA_DISABLE_PERSONAL_ASSISTANT?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * The opt-in standalone Telegram polling bot (the standalone mode of
 * `@elizaos/plugin-telegram`) runs when `ELIZA_TELEGRAM_STANDALONE_BOT` is
 * truthy and the resolved plugin set is not in LifeOps passive mode. The same
 * runtime-time gate is enforced by `TelegramStandaloneService`; this host gate
 * ensures the plugin is present for that service to start.
 */
function telegramStandaloneRequested(
  pluginNames: ReadonlySet<string>,
): boolean {
  // Host loading policy: before runtime construction only resolved package
  // names exist, and the personal-assistant package is the one whose Plugin
  // declares `passiveConnectorsByDefault`. An explicit operator setting wins;
  // otherwise the presence of that package predicts the runtime-time gate.
  const passive =
    lifeOpsPassiveConnectorsSetting(null, process.env) ??
    pluginNames.has("@elizaos/plugin-personal-assistant");
  if (passive) {
    return false;
  }
  const raw = process.env.ELIZA_TELEGRAM_STANDALONE_BOT?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
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
  "@elizaos/plugin-shell": "@elizaos/plugin-coding-tools",
  "@elizaos/plugin-discord-local": "@elizaos/plugin-discord",
  "@elizaos/plugin-telegram-standalone": "@elizaos/plugin-telegram",
  "@homunculuslabs/plugin-zai": "@elizaos/plugin-zai",
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

function providerPluginNameFromBackend(backend: string): string {
  const explicitPluginName = resolvePluginPackageAlias(
    packageNameFromPluginConfigId(backend),
  );
  if (
    DIRECT_MODEL_PROVIDER_PLUGINS.has(explicitPluginName) ||
    LOCAL_MODEL_PROVIDER_PLUGINS.has(explicitPluginName)
  ) {
    return explicitPluginName;
  }
  const providerId = normalizeFirstRunProviderId(backend);
  if (providerId && providerId !== "elizacloud") {
    const provider = getFirstRunProviderOption(providerId);
    if (provider) {
      return resolvePluginPackageAlias(provider.pluginName);
    }
  }
  return explicitPluginName;
}

function isDirectlyRoutableProviderPlugin(
  backend: string,
  pluginName: string,
): boolean {
  if (
    DIRECT_MODEL_PROVIDER_PLUGINS.has(pluginName) ||
    LOCAL_MODEL_PROVIDER_PLUGINS.has(pluginName)
  ) {
    return true;
  }
  const provider = getFirstRunProviderOption(backend);
  return (
    provider !== null &&
    provider.id !== "elizacloud" &&
    resolvePluginPackageAlias(provider.pluginName) === pluginName
  );
}

function isTruthyCloudEnvValue(raw: string | undefined): boolean {
  if (!raw) return false;
  const value = raw.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function isStoreBuildVariant(): boolean {
  const raw =
    process.env.ELIZA_BUILD_VARIANT?.trim() ||
    process.env.ELIZA_BUILD_VARIANT?.trim();
  return raw?.toLowerCase() === "store";
}

/**
 * Maps Eliza channel names to plugin package names. Derived at registry build
 * time from each connector entry's `channels` (e.g. x -> ["x", "twitter"]); see
 * packages/registry/src/first-party. To add/rename a channel, edit the owning
 * connector's registry-entry.json `channels` and regenerate — not this list.
 */
export const CHANNEL_PLUGIN_MAP: Readonly<Record<string, string>> =
  channelPluginMap;

/**
 * Maps environment variable names to model-provider plugin packages. Derived at
 * registry build time from config fields marked `autoEnableProvider`; see
 * packages/registry/src/first-party. To add or rename a provider env key, edit
 * the owning registry entry and regenerate — not this list.
 */
export const PROVIDER_PLUGIN_MAP: Readonly<Record<string, string>> =
  providerPluginMap;

/**
 * Every model-provider plugin package (the values of {@link PROVIDER_PLUGIN_MAP}).
 * A configured provider is first-turn capability — chat cannot answer without a
 * TEXT_GENERATION handler — so the boot phase split treats these as blocking:
 * a provider that made it into the load set registers BEFORE the runtime
 * reports ready (agentState `running` / `canRespond`), never in the deferred
 * wave. Otherwise the readiness signal flips while the first chat turns still
 * answer "no LLM provider configured" (#14038 wake-status lag).
 */
export const MODEL_PROVIDER_PLUGIN_NAMES: ReadonlySet<string> = new Set(
  Object.values(PROVIDER_PLUGIN_MAP),
);

const LOCAL_MODEL_PROVIDER_PLUGINS = new Set<string>([
  "@elizaos/plugin-local-inference",
  "@elizaos/plugin-zerollama",
]);

const REMOTE_MODEL_PROVIDER_PLUGINS = new Set(
  Object.values(PROVIDER_PLUGIN_MAP).filter(
    (pluginName) =>
      pluginName !== "@elizaos/plugin-elizacloud" &&
      !LOCAL_MODEL_PROVIDER_PLUGINS.has(pluginName),
  ),
);

const DIRECT_MODEL_PROVIDER_PLUGINS = new Set(
  Object.values(PROVIDER_PLUGIN_MAP).filter(
    (pluginName) => pluginName !== "@elizaos/plugin-elizacloud",
  ),
);

function removeLocalModelSurfaces(pluginsToLoad: Set<string>): void {
  for (const pluginName of LOCAL_MODEL_PROVIDER_PLUGINS) {
    pluginsToLoad.delete(pluginName);
  }
}

function removeDirectModelProviderSurfaces(pluginsToLoad: Set<string>): void {
  for (const pluginName of DIRECT_MODEL_PROVIDER_PLUGINS) {
    pluginsToLoad.delete(pluginName);
  }
  removeLocalModelSurfaces(pluginsToLoad);
}

function removeAllModelProviderSurfaces(pluginsToLoad: Set<string>): void {
  pluginsToLoad.delete("@elizaos/plugin-elizacloud");
  removeDirectModelProviderSurfaces(pluginsToLoad);
}

/**
 * Legacy host-owned short-id aliases for optional plugins that do NOT yet ship a
 * `registry-entry.json` (so their aliases cannot be derived at registry-build
 * time like {@link CHANNEL_PLUGIN_MAP} / {@link PROVIDER_PLUGIN_MAP}). Each key
 * is a bare short id that `plugins.allow`, `plugins.entries`, or
 * `config.features` may carry; without an entry here collectPluginNames() would
 * fall through to loading the short id as a literal package name (`import("obsidian")`),
 * which silently fails inside the loader's error boundary. This is the shrinking
 * legacy tail — when one of these plugins adds a registry entry, move its aliases
 * into that entry's `shortIds` and delete the row here.
 */
const LEGACY_HOST_OWNED_SHORT_ID_MAP: Readonly<Record<string, string>> = {
  // plugin-obsidian (no registry-entry.json yet).
  obsidian: "@elizaos/plugin-obsidian",
  // plugin-repoprompt (no registry-entry.json yet).
  repoprompt: "@elizaos/plugin-repoprompt",
  repoPrompt: "@elizaos/plugin-repoprompt",
  // plugin-x402 (no registry-entry.json yet).
  x402: "@elizaos/plugin-x402",
  // plugin-manager, secrets (SECRETS), trust: now built-in core capabilities.
  // Enable via ENABLE_PLUGIN_MANAGER, ENABLE_SECRETS_MANAGER, ENABLE_TRUST.
  // Steward wallet plugin — short ID used by auto-enable; third-party npm scope,
  // no first-party registry entry.
  "stwd-eliza-plugin": "@stwd/eliza-plugin",
};

/**
 * Optional feature plugins keyed by short id.
 *
 * Mappings here support short IDs in allow-lists and feature toggles. Short ids
 * must resolve to real package names or optional plugins silently fail inside
 * the loader's error boundary (`import("evm")` -> "Cannot find module").
 *
 * The registry-owned aliases (wallet, browser, polymarket, vision, …) are
 * generated at registry-build time from each entry's `shortIds` field — see
 * `collectShortIdPluginMap` in packages/registry/src/first-party/generate.ts.
 * To add or rename one of those aliases, edit the owning plugin's
 * registry-entry.json `shortIds` and regenerate — not this map. The generator
 * fails loudly if two plugins claim the same short id, so drift cannot ship.
 *
 * {@link LEGACY_HOST_OWNED_SHORT_ID_MAP} is the shrinking tail of plugins that
 * do not yet declare a registry entry; it is layered underneath the generated
 * map so a registry entry always wins over a stale hand-maintained row.
 */
export const OPTIONAL_PLUGIN_MAP: Readonly<Record<string, string>> = {
  ...LEGACY_HOST_OWNED_SHORT_ID_MAP,
  ...(shortIdPluginMap as Readonly<Record<string, string>>),
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
 * Explicit Google signals only — never inferred from the universal Calendar
 * home tile (Apple/Microsoft/ICS also use Calendar).
 */
function shouldLoadGoogleWorkspace(
  config: ElizaConfig,
  env: NodeJS.ProcessEnv,
  pluginEntries: Record<string, { enabled?: boolean } | undefined> | undefined,
): boolean {
  if (pluginEntries?.["google-workspace"]?.enabled === true) {
    return true;
  }

  const connectors = config.connectors as Record<string, unknown> | undefined;
  if (isGoogleChatConfigured(connectors?.googlechat)) {
    return true;
  }

  // Match readClientConfig(): OAuth cannot start without redirect URI either.
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  const redirectUri = env.GOOGLE_REDIRECT_URI?.trim();
  return Boolean(clientId && clientSecret && redirectUri);
}

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
  const cloudTopology = resolveElizaCloudTopology(
    config as Record<string, unknown>,
  );
  const hasCanonicalRuntimeConfig = hasExplicitCanonicalRuntimeConfig(
    config as Record<string, unknown>,
  );
  const isCloudContainer = readAliasedEnv("ELIZA_CLOUD_PROVISIONED") === "1";
  const storeBuild = isStoreBuildVariant();
  const cloudExplicitlyDisabled = config.cloud?.enabled === false;
  // `ELIZA_LOCAL_LLAMA=1` is the AOSP / on-device signal that the in-process
  // llama.cpp loader is wired up and should be available as a routable
  // provider. It does NOT mean "strip every other provider": subscription
  // accounts (anthropic-subscription, openai-codex) and API-key cloud
  // plugins must keep loading so the user can route slots to them.
  // The local handler registers in the same priority band as direct providers;
  // the top-priority router's default prefer-local policy decides the winner
  // when the user has multiple configured candidates.
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
  const _configEnv = config.env as
    | (Record<string, unknown> & { vars?: Record<string, unknown> })
    | undefined;
  const hasUsableCloudApiKey = [
    process.env.ELIZAOS_CLOUD_API_KEY,
    config.cloud?.apiKey,
    _configEnv?.ELIZAOS_CLOUD_API_KEY,
    _configEnv?.vars?.ELIZAOS_CLOUD_API_KEY,
  ].some(isUsableCloudApiKey);
  // cloudHandlesInference gates whether the cloud plugin *replaces* direct
  // provider plugins for model calls. Configured Cloud intent is insufficient:
  // without the credential used by plugin-elizacloud, removing the fallback
  // providers leaves only an unservable priority-50 Cloud route (#20045).
  // Provisioned containers own their repaired Cloud runtime route even before
  // host env projection; ordinary hosts require the usable credential itself.
  const cloudHandlesInference =
    (cloudTopology.services.inference &&
      (hasUsableCloudApiKey || isCloudContainer)) ||
    (isCloudContainer && hasUsableCloudApiKey);
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
    ([, entry]) => entry.enabled === true,
  );

  // Allow-list entries are additive (extra plugins), not exclusive.
  const allowList = config.plugins?.allow;
  // On mobile (ELIZA_PLATFORM=android|ios) the desktop core list pulls in
  // ~10 plugins that depend on subprocesses, platform
  // launchers (/usr/bin/open, osascript, xdg-open), or PTY tooling — all
  // unavailable in the app sandbox. Substitute the curated mobile-safe set.
  const onMobile = isMobilePlatform();
  const onElizaOsAndroid = isElizaOsAndroidRuntime();
  // Dedicated chat-only cloud agents opt into a lean plugin set (no shell/
  // coding-tools/browser/orchestrator) to cut cold-boot time (#8434). Mobile keeps
  // its own curated set; lean-chat only applies off-mobile.
  const leanChat =
    !onMobile &&
    process.env.ELIZA_PLUGIN_SET?.trim().toLowerCase() === "lean-chat";
  const seedCorePlugins = onMobile
    ? MOBILE_CORE_PLUGINS
    : leanChat
      ? LEAN_CHAT_PLUGINS
      : CORE_PLUGINS;
  const pluginsToLoad = new Set<string>(seedCorePlugins);
  const track = (name: string, reason: string) => {
    if (reasons && !reasons.has(name)) reasons.set(name, reason);
  };
  for (const core of seedCorePlugins) {
    track(
      core,
      leanChat
        ? "LEAN_CHAT_PLUGINS"
        : onMobile
          ? "MOBILE_CORE_PLUGINS"
          : "CORE_PLUGINS",
    );
  }
  // View-providing plugins register their /api/views entries on every platform
  // so their home tiles resolve (the orchestrator/inbox tiles dead-ended on
  // mobile before this). They're views-only or degrade gracefully without a
  // backend; the mobile allow-list below keeps them.
  for (const viewPlugin of MOBILE_VIEW_PLUGINS) {
    pluginsToLoad.add(viewPlugin);
    track(viewPlugin, "MOBILE_VIEW_PLUGINS (home-tile view)");
  }
  // ElizaOS-only: add the system-surface overlay app plugins (WiFi,
  // Contacts, Phone). These wrap privileged Android system APIs available
  // only in the custom AOSP build, not in the stock Android APK. The overlay
  // UI registration happens in the renderer via @elizaos/plugin-*/register
  // imports — these are the *runtime* plugin halves that expose actions
  // to the agent for `Connect to wifi`, `Find contact`, `Call so-and-so`.
  if (onElizaOsAndroid) {
    for (const name of ELIZAOS_ANDROID_CORE_PLUGINS) {
      pluginsToLoad.add(name);
      track(name, "ELIZAOS_ANDROID_CORE_PLUGINS");
    }
    for (const name of ELIZAOS_ANDROID_TERMINAL_PLUGINS) {
      pluginsToLoad.add(name);
      track(name, "ELIZAOS_ANDROID_TERMINAL_PLUGINS");
    }
  }
  // Agent orchestrator depends on PTY / coding-swarm subprocesses. Stock mobile
  // never gets it; privileged AOSP adds it through
  // ELIZAOS_ANDROID_TERMINAL_PLUGINS above so it can use the bundled Bun service
  // and Android shell process model.
  if (!onMobile && orchestratorCompatPluginRequested(config)) {
    // Only the BACKEND is gated to non-mobile + an explicit request. The
    // operator-console view (@elizaos/plugin-task-coordinator) is seeded for
    // all platforms via MOBILE_VIEW_PLUGINS above (views-only, degrades
    // gracefully without the backend), so the /orchestrator tile resolves
    // everywhere.
    pluginsToLoad.add("agent-orchestrator");
    track(
      "agent-orchestrator",
      "agent-orchestrator (@elizaos/plugin-agent-orchestrator)",
    );
  }
  // Dedicated cloud containers get the local-desktop operator surface by
  // default: the web terminal's PTY service and the BYO-subscription CLI
  // inference lane. Both are dormant until used — plugin-pty registers
  // PTY_SERVICE and waits for a terminal to connect; plugin-cli-inference's
  // model map is inert unless ELIZA_CHAT_VIA_CLI selects a backend. lean-chat
  // containers stay lean: these are in LEAN_CHAT_EXCLUDED_PLUGINS.
  if (
    !onMobile &&
    !leanChat &&
    readAliasedEnv("ELIZA_CLOUD_PROVISIONED") === "1"
  ) {
    pluginsToLoad.add("@elizaos/plugin-pty");
    track(
      "@elizaos/plugin-pty",
      "cloud container default (web terminal PTY service)",
    );
    pluginsToLoad.add("@elizaos/plugin-cli-inference");
    track(
      "@elizaos/plugin-cli-inference",
      "cloud container default (inert unless ELIZA_CHAT_VIA_CLI selects a backend)",
    );
    // Cloud containers drop local inference unless the on-device signal is
    // explicitly set: they have no GPU, the on-device gte-small embedder runs
    // 1.5–98s per batch on contended container CPU, and its 384-dim vectors
    // mismatch the cloud's 1536-dim TEXT_EMBEDDING — dropping every memory
    // insert (see LEAN_CHAT_EXCLUDED_PLUGINS, which already encodes this for
    // lean chat). The cloud embedding handler serves TEXT_EMBEDDING instead.
    if (process.env.ELIZA_LOCAL_LLAMA?.trim() !== "1") {
      pluginsToLoad.delete("@elizaos/plugin-local-inference");
    }
  }
  if (!onMobile && gitpathologistRequested(config)) {
    pluginsToLoad.add("@elizaos/plugin-gitpathologist");
    track(
      "@elizaos/plugin-gitpathologist",
      "gitpathologist (auto-on when .git/ present; gate ELIZA_GITPATHOLOGIST)",
    );
  }
  // The host app owns default feature selection through `elizaos.app.defaults`
  // in its package manifest. A standalone @elizaos/agent installation must not
  // implicitly select a package outside its published dependency closure.
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
    // googlechat → google-workspace: require real Chat config, not empty `{}`.
    if (
      channelName === "googlechat" &&
      !isGoogleChatConfigured(channelConfig)
    ) {
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
    if (deploymentTarget.runtime === "remote") {
      removeAllModelProviderSurfaces(pluginsToLoad);
      return;
    }

    if (deploymentTarget.runtime === "cloud") {
      // A Cloud runtime can keep its managed state/capability routes while the
      // owner supplies the text brain directly. The canonical llmText route is
      // the arbitration signal; stripping direct providers here would make the
      // persisted route impossible to execute and let Cloud inference win.
      const directlyRoutedProviderPlugins = new Set(
        Object.values(serviceRouting ?? {}).flatMap((route) => {
          if (route?.transport !== "direct" || !route.backend) return [];
          const pluginName = providerPluginNameFromBackend(route.backend);
          return isDirectlyRoutableProviderPlugin(route.backend, pluginName)
            ? [pluginName]
            : [];
        }),
      );
      // Ambient credentials may belong to other tools or stale configuration;
      // the canonical route matrix is the sole ownership signal in Cloud mode.
      removeDirectModelProviderSurfaces(pluginsToLoad);
      for (const pluginName of directlyRoutedProviderPlugins) {
        pluginsToLoad.add(pluginName);
      }
      for (const pluginName of LOCAL_MODEL_PROVIDER_PLUGINS) {
        if (directlyRoutedProviderPlugins.has(pluginName)) {
          pluginsToLoad.add(pluginName);
        } else {
          pluginsToLoad.delete(pluginName);
        }
      }
      if (cloudEffectivelyEnabled) {
        pluginsToLoad.add("@elizaos/plugin-elizacloud");
      } else {
        pluginsToLoad.delete("@elizaos/plugin-elizacloud");
      }
      return;
    }

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
        removeDirectModelProviderSurfaces(pluginsToLoad);
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
    // Shell execution ships inside plugin-coding-tools; disabling shell
    // disables the whole local coding-tools surface.
    pluginsToLoad.delete("@elizaos/plugin-coding-tools");
  }
  if (storeBuild) {
    for (const pluginName of STORE_BUILD_LOCAL_EXECUTION_PLUGINS) {
      pluginsToLoad.delete(pluginName);
    }
  }

  for (const pluginName of Array.from(pluginsToLoad)) {
    if (isPluginExplicitlyDisabled(pluginName)) {
      pluginsToLoad.delete(pluginName);
    }
  }
  if (
    personalAssistantDisabledByEnv() ||
    leanChat ||
    storeBuild ||
    isCloudContainer
  ) {
    pluginsToLoad.delete("@elizaos/plugin-personal-assistant");
  }

  // Calendar home tiles load on every platform (MOBILE_VIEW_PLUGINS). Calendar
  // hard-depends on plugin-scheduling (watch/reminder spine); always companion
  // that primitive when calendar is present.
  //
  // Do NOT infer Google Workspace from Calendar alone — Calendar also covers
  // Apple/Microsoft/ICS. Load google-workspace only on an explicit Google
  // signal (entries enable, googlechat connector, or full GOOGLE_CLIENT_* trio),
  // and never when entries["google-workspace"].enabled === false.
  //
  // Run BEFORE the mobile allow-list so Node-only Workspace cannot be re-added
  // after mobile filtering (APK has no google-workspace bundle).
  if (pluginsToLoad.has("@elizaos/plugin-calendar")) {
    if (!pluginsToLoad.has("@elizaos/plugin-scheduling")) {
      pluginsToLoad.add("@elizaos/plugin-scheduling");
      track("@elizaos/plugin-scheduling", "calendar companion");
    }
  }
  if (
    !pluginsToLoad.has("@elizaos/plugin-google-workspace") &&
    !isPluginExplicitlyDisabled("@elizaos/plugin-google-workspace") &&
    shouldLoadGoogleWorkspace(config, process.env, pluginEntries)
  ) {
    pluginsToLoad.add("@elizaos/plugin-google-workspace");
    track(
      "@elizaos/plugin-google-workspace",
      "explicit Google signal (entries / googlechat / GOOGLE_CLIENT_*)",
    );
  }
  // Final deny: explicit disable wins even if an earlier path added Workspace.
  if (isPluginExplicitlyDisabled("@elizaos/plugin-google-workspace")) {
    pluginsToLoad.delete("@elizaos/plugin-google-workspace");
  }

  // Mobile: restrict the final set to plugins that the bundled mobile runtime
  // can actually load — the mobile-core list plus model-provider plugins that
  // are statically imported in `runtime/eliza.ts`. Anything else (connector
  // plugins, feature plugins from `plugins.entries`, drop-in plugins from
  // `plugins.installs`) would force a dynamic `import("@elizaos/plugin-...")`
  // against a `node_modules` tree that does not ship in the APK.
  // Must run AFTER companion adds so google-workspace cannot bypass the filter.
  if (onMobile) {
    const mobileAllowed = new Set<string>([
      ...MOBILE_CORE_PLUGINS,
      ...MOBILE_VIEW_PLUGINS,
      ...(onElizaOsAndroid ? ELIZAOS_ANDROID_CORE_PLUGINS : []),
      ...(onElizaOsAndroid ? ELIZAOS_ANDROID_TERMINAL_PLUGINS : []),
      ...MOBILE_MODEL_PROVIDER_PLUGINS,
    ]);
    for (const pluginName of Array.from(pluginsToLoad)) {
      if (!mobileAllowed.has(pluginName)) {
        pluginsToLoad.delete(pluginName);
      }
    }
  }

  // Lean chat: force-drop heavy surfaces even if a later gate (orchestrator env,
  // gitpathologist .git auto-detect, config allow-list) added them, so a
  // lean-chat agent is guaranteed minimal. (#8434)
  if (leanChat) {
    // OPT-IN local-primary embeddings for lean-chat cloud agents.
    //
    // #8762 excluded @elizaos/plugin-local-inference from lean-chat entirely
    // because on a cloud container the on-device gte-small GGUF (a) ran
    // 1.5-98s/batch on the contended CPU and (b) emitted 384-dim vectors into
    // a 1536-dim column, dropping every insert. That was the right default at
    // the time. But local gte-small is now measured at 17-48ms/embed on the
    // live VPS, 10-20x faster than the cloud OpenAI round-trip (~250ms), so
    // for a cloud agent whose store is re-provisioned at gte-small's 384-dim
    // width, local-primary is a strict win on the always-on recall hot path.
    //
    // Gated behind ELIZA_LEAN_CHAT_LOCAL_EMBEDDINGS (default OFF): a hot flip
    // for EXISTING 1536-dim agents would degrade recall until re-embedded
    // (#9911 failure class), so this stays opt-in and rolls out per-agent with
    // a backfill. When the flag is set, keep plugin-local-inference loaded so
    // it can win the TEXT_EMBEDDING registration, and signal the cloud plugin
    // to yield the slot (ELIZAOS_CLOUD_USE_EMBEDDINGS=false unless the operator
    // explicitly pinned it true) so the two providers don't both register.
    const localEmbeddingsOptIn =
      readAliasedEnv("ELIZA_LEAN_CHAT_LOCAL_EMBEDDINGS") === "1" &&
      process.env.ELIZAOS_CLOUD_USE_EMBEDDINGS?.trim().toLowerCase() !== "true";
    for (const name of LEAN_CHAT_EXCLUDED_PLUGINS) {
      if (localEmbeddingsOptIn && name === "@elizaos/plugin-local-inference") {
        // Keep the local embedder; ensure it wins TEXT_EMBEDDING over cloud.
        pluginsToLoad.add(name);
        track(
          name,
          "lean-chat local-primary embeddings (ELIZA_LEAN_CHAT_LOCAL_EMBEDDINGS=1)",
        );
        // Yield the cloud embedding slot so plugin-elizacloud does not also
        // register TEXT_EMBEDDING (registerCloudEmbeddingModels checks this).
        if (!process.env.ELIZAOS_CLOUD_USE_EMBEDDINGS) {
          process.env.ELIZAOS_CLOUD_USE_EMBEDDINGS = "false";
        }
        continue;
      }
      pluginsToLoad.delete(name);
    }
  }

  // Decide standalone Telegram only after every config, install, companion,
  // and platform filter has produced the actual pre-runtime plugin set. This
  // keeps host collection consistent with the service's runtime-time gate:
  // LifeOps stays passive, while a plain standalone agent can opt into its
  // poller without an unrelated passive-connectors override.
  if (!onMobile && !leanChat && telegramStandaloneRequested(pluginsToLoad)) {
    pluginsToLoad.add("@elizaos/plugin-telegram");
    track(
      "@elizaos/plugin-telegram",
      "telegram standalone bot (gate ELIZA_TELEGRAM_STANDALONE_BOT)",
    );
  }

  return pluginsToLoad;
}

function resolveCloudPluginRequirement(
  topology: ResolvedElizaCloudTopology,
  requestedByEnv: boolean,
): boolean {
  return topology.shouldLoadPlugin || requestedByEnv;
}
