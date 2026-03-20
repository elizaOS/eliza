/**
 * elizaOS runtime entry point for Milaidy.
 *
 * Starts the elizaOS agent runtime with Milaidy's plugin configuration.
 * Can be run directly via: node --import tsx src/eliza.ts
 * Or via the CLI: milaidy start
 *
 * @module eliza
 */
import crypto from "node:crypto";
import process from "node:process";
import * as readline from "node:readline";
import {
  AgentRuntime,
  ChannelType,
  createCharacter,
  createMessageMemory,
  InMemoryDatabaseAdapter,
  logger,
  provisionAgent,
  mergeDbSettings,
  stringToUuid,
  type Character,
  type Plugin,
  type UUID,
} from "@elizaos/core";
import * as clack from "@clack/prompts";
import { VERSION } from "./version.js";
import {
  applyPluginAutoEnable,
  type ApplyPluginAutoEnableParams,
} from "./config/plugin-auto-enable.js";
import { loadMilaidyConfig, saveMilaidyConfig, configFileExists, type MilaidyConfig } from "./config/config.js";
import { loadHooks, triggerHook, createHookEvent, type LoadHooksOptions } from "./hooks/index.js";
import { createMilaidyPlugin } from "./milaidy-plugin.js";
import {
  ensureAgentWorkspace,
  resolveDefaultAgentWorkspaceDir,
} from "./providers/workspace.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A successfully resolved plugin ready for AgentRuntime registration. */
interface ResolvedPlugin {
  /** npm package name (e.g. "@elizaos/plugin-anthropic"). */
  name: string;
  /** The Plugin instance extracted from the module. */
  plugin: Plugin;
}

/** Shape we expect from a dynamically-imported plugin package. */
interface PluginModuleShape {
  default?: Plugin;
  plugin?: Plugin;
}

// ---------------------------------------------------------------------------
// Channel secret mapping
// ---------------------------------------------------------------------------

/**
 * Maps Milaidy channel config fields to the environment variable names
 * that elizaOS plugins expect.
 *
 * Milaidy stores channel credentials under `config.channels.<name>.<field>`,
 * while elizaOS plugins read them from process.env.
 */
const CHANNEL_ENV_MAP: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  discord: {
    token: "DISCORD_BOT_TOKEN",
  },
  telegram: {
    botToken: "TELEGRAM_BOT_TOKEN",
  },
  slack: {
    botToken: "SLACK_BOT_TOKEN",
    appToken: "SLACK_APP_TOKEN",
    userToken: "SLACK_USER_TOKEN",
  },
  signal: {
    account: "SIGNAL_ACCOUNT",
  },
  msteams: {
    appId: "MSTEAMS_APP_ID",
    appPassword: "MSTEAMS_APP_PASSWORD",
  },
  mattermost: {
    botToken: "MATTERMOST_BOT_TOKEN",
    baseUrl: "MATTERMOST_BASE_URL",
  },
  googlechat: {
    serviceAccountKey: "GOOGLE_CHAT_SERVICE_ACCOUNT_KEY",
  },
};

// ---------------------------------------------------------------------------
// Plugin resolution
// ---------------------------------------------------------------------------

/** Core plugins that should always be loaded. */
const CORE_PLUGINS: readonly string[] = [
  "@elizaos/plugin-sql",
  "@elizaos/plugin-agent-skills",
  "@elizaos/plugin-directives",
  "@elizaos/plugin-commands",
  "@elizaos/plugin-shell",
  "@elizaos/plugin-personality",
  "@elizaos/plugin-experience",
  "@elizaos/plugin-form",
  // "@elizaos/plugin-browser",  // Requires browser server binary; skip for dev
  // "@elizaos/plugin-cron",     // Requires worldId; skip for dev
];

/** Maps Milaidy channel names to elizaOS plugin package names. */
const CHANNEL_PLUGIN_MAP: Readonly<Record<string, string>> = {
  discord: "@elizaos/plugin-discord",
  telegram: "@elizaos/plugin-telegram",
  slack: "@elizaos/plugin-slack",
  whatsapp: "@elizaos/plugin-whatsapp",
  signal: "@elizaos/plugin-signal",
  imessage: "@elizaos/plugin-imessage",
  bluebubbles: "@elizaos/plugin-bluebubbles",
  msteams: "@elizaos/plugin-msteams",
  mattermost: "@elizaos/plugin-mattermost",
  googlechat: "@elizaos/plugin-google-chat",
};

/** Maps environment variable names to model-provider plugin packages. */
const PROVIDER_PLUGIN_MAP: Readonly<Record<string, string>> = {
  ANTHROPIC_API_KEY: "@elizaos/plugin-anthropic",
  OPENAI_API_KEY: "@elizaos/plugin-openai",
  GOOGLE_API_KEY: "@elizaos/plugin-google-genai",
  GOOGLE_GENERATIVE_AI_API_KEY: "@elizaos/plugin-google-genai",
  GROQ_API_KEY: "@elizaos/plugin-groq",
  XAI_API_KEY: "@elizaos/plugin-xai",
  OPENROUTER_API_KEY: "@elizaos/plugin-openrouter",
  OLLAMA_BASE_URL: "@elizaos/plugin-ollama",
  // ElizaCloud — loaded when API key is present OR cloud is explicitly enabled
  ELIZAOS_CLOUD_API_KEY: "@elizaos/plugin-elizacloud",
  ELIZAOS_CLOUD_ENABLED: "@elizaos/plugin-elizacloud",
};

/** Optional feature plugins keyed by feature name. */
const OPTIONAL_PLUGIN_MAP: Readonly<Record<string, string>> = {};

function looksLikePlugin(value: unknown): value is Plugin {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.name === "string" && typeof obj.description === "string";
}

function extractPlugin(mod: PluginModuleShape): Plugin | null {
  if (looksLikePlugin(mod.default)) return mod.default;
  if (looksLikePlugin(mod.plugin)) return mod.plugin;
  if (looksLikePlugin(mod)) return mod as unknown as Plugin;
  return null;
}

/**
 * Collect the set of plugin package names that should be loaded
 * based on config, environment variables, and feature flags.
 */
/** @internal Exported for testing. */
export function collectPluginNames(config: MilaidyConfig): Set<string> {
  const pluginsToLoad = new Set<string>(CORE_PLUGINS);

  // Channel plugins — load when channel has config entries
  const channels = config.channels ?? {};
  for (const [channelName, channelConfig] of Object.entries(channels)) {
    if (channelConfig && typeof channelConfig === "object") {
      const pluginName = CHANNEL_PLUGIN_MAP[channelName];
      if (pluginName) {
        pluginsToLoad.add(pluginName);
      }
    }
  }

  // Model-provider plugins — load when env key is present
  for (const [envKey, pluginName] of Object.entries(PROVIDER_PLUGIN_MAP)) {
    if (process.env[envKey]) {
      pluginsToLoad.add(pluginName);
    }
  }

  // ElizaCloud plugin — also load when cloud config is explicitly enabled
  if (config.cloud?.enabled) {
    pluginsToLoad.add("@elizaos/plugin-elizacloud");
  }

  // Optional feature plugins from config.plugins.entries
  const pluginsConfig = config.plugins as Record<string, Record<string, unknown>> | undefined;
  if (pluginsConfig?.entries) {
    for (const [key, entry] of Object.entries(pluginsConfig.entries)) {
      if (entry && typeof entry === "object" && (entry as Record<string, unknown>).enabled !== false) {
        const pluginName = OPTIONAL_PLUGIN_MAP[key];
        if (pluginName) {
          pluginsToLoad.add(pluginName);
        }
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
          pluginsToLoad.add(pluginName);
        }
      }
    }
  }

  return pluginsToLoad;
}

/**
 * Resolve Milaidy plugins from config and auto-enable logic.
 * Returns an array of elizaOS Plugin instances ready for AgentRuntime.
 */
async function resolvePlugins(config: MilaidyConfig): Promise<ResolvedPlugin[]> {
  const plugins: ResolvedPlugin[] = [];

  // Run auto-enable to log which plugins would be activated
  const autoEnableResult = applyPluginAutoEnable({
    config,
    env: process.env,
  } satisfies ApplyPluginAutoEnableParams);

  const pluginsToLoad = collectPluginNames(config);

  // Dynamically import each plugin
  for (const pluginName of pluginsToLoad) {
    try {
      const mod = (await import(pluginName)) as PluginModuleShape;
      const pluginInstance = extractPlugin(mod);

      if (pluginInstance) {
        plugins.push({ name: pluginName, plugin: pluginInstance });
      } else {
        logger.warn(`[milaidy] Plugin ${pluginName} did not export a valid Plugin object`);
      }
    } catch (err) {
      // Don't crash on optional plugins — just warn
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[milaidy] Could not load plugin ${pluginName}: ${msg}`);
    }
  }

  return plugins;
}

// ---------------------------------------------------------------------------
// Config → Character mapping
// ---------------------------------------------------------------------------

/**
 * Propagate channel credentials from Milaidy config into process.env so
 * that elizaOS plugins can find them.
 */
/** @internal Exported for testing. */
export function applyChannelSecretsToEnv(config: MilaidyConfig): void {
  const channels = config.channels ?? {};

  for (const [channelName, channelConfig] of Object.entries(channels)) {
    if (!channelConfig || typeof channelConfig !== "object") continue;

    const envMap = CHANNEL_ENV_MAP[channelName];
    if (!envMap) continue;

    const configObj = channelConfig as Record<string, unknown>;
    for (const [configField, envKey] of Object.entries(envMap)) {
      const value = configObj[configField];
      if (typeof value === "string" && value.trim() && !process.env[envKey]) {
        process.env[envKey] = value;
      }
    }
  }
}

/**
 * Propagate cloud config from Milaidy config into process.env so the
 * ElizaCloud plugin can discover settings at startup.
 */
/** @internal Exported for testing. */
export function applyCloudConfigToEnv(config: MilaidyConfig): void {
  const cloud = config.cloud;
  if (!cloud) return;

  if (cloud.enabled && !process.env.ELIZAOS_CLOUD_ENABLED) {
    process.env.ELIZAOS_CLOUD_ENABLED = "true";
  }
  if (cloud.apiKey && !process.env.ELIZAOS_CLOUD_API_KEY) {
    process.env.ELIZAOS_CLOUD_API_KEY = cloud.apiKey;
  }
  if (cloud.baseUrl && !process.env.ELIZAOS_CLOUD_BASE_URL) {
    process.env.ELIZAOS_CLOUD_BASE_URL = cloud.baseUrl;
  }
}

/**
 * Build an elizaOS Character from the Milaidy config.
 *
 * Merges the deprecated `config.agent` object and the newer
 * `config.agents.defaults` into a single Character, collecting
 * secrets from environment variables along the way.
 */
/** @internal Exported for testing. */
export function buildCharacterFromConfig(config: MilaidyConfig): Character {
  // Support both legacy agent config and new agents config
  const legacyAgent = config.agent;

  const name =
    legacyAgent?.name ??
    config.ui?.assistant?.name ??
    "Milaidy";

  const bio =
    legacyAgent?.bio ??
    "An AI assistant powered by Milaidy and elizaOS.";

  const systemPrompt = legacyAgent?.system_prompt;

  // Collect secrets from process.env (API keys the plugins need)
  const secretKeys = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GROQ_API_KEY",
    "XAI_API_KEY",
    "OPENROUTER_API_KEY",
    "OLLAMA_BASE_URL",
    "DISCORD_BOT_TOKEN",
    "TELEGRAM_BOT_TOKEN",
    "SLACK_BOT_TOKEN",
    "SLACK_APP_TOKEN",
    "SLACK_USER_TOKEN",
    "SIGNAL_ACCOUNT",
    "MSTEAMS_APP_ID",
    "MSTEAMS_APP_PASSWORD",
    "MATTERMOST_BOT_TOKEN",
    "MATTERMOST_BASE_URL",
    // ElizaCloud secrets
    "ELIZAOS_CLOUD_API_KEY",
    "ELIZAOS_CLOUD_BASE_URL",
    "ELIZAOS_CLOUD_ENABLED",
  ];

  const secrets: Record<string, string> = {};
  for (const key of secretKeys) {
    const value = process.env[key];
    if (value && value.trim()) {
      secrets[key] = value;
    }
  }

  return createCharacter({
    name,
    bio,
    system: systemPrompt,
    secrets,
  });
}

/**
 * Resolve the primary model identifier from Milaidy config.
 *
 * Milaidy stores the model under `agents.defaults.model.primary` as an
 * AgentModelListConfig object. Returns undefined when no model is
 * explicitly configured (elizaOS falls back to whichever model
 * plugin is loaded).
 */
/** @internal Exported for testing. */
export function resolvePrimaryModel(config: MilaidyConfig): string | undefined {
  const modelConfig = config.agents?.defaults?.model;
  if (!modelConfig) return undefined;

  // AgentDefaultsConfig.model is AgentModelListConfig: { primary?, fallbacks? }
  return modelConfig.primary;
}

// ---------------------------------------------------------------------------
// First-run onboarding
// ---------------------------------------------------------------------------

/** Pool of agent names to randomly sample from during first-run onboarding. */
const AGENT_NAME_POOL: readonly string[] = [
  "Reimu", "Flandre", "Remilia", "Sakuya", "Cirno", "Patchouli", "Yukari",
  "Alice", "Marisa", "Byakuren", "Youmu", "Koakuma", "Reisen", "Yuyuko",
  "Aya", "Ran", "Sanae", "Suika", "Koishi", "Nue", "Chen", "Mokou",
  "Satori", "Suwako", "Momiji", "Tenshi", "Utsuho", "Kaguya", "Komachi",
  "Nitori", "Meiling", "Shikieiki", "Kasen", "Lily", "Mima", "Yuuka",
  "Kogasa", "Rin", "Rumia", "Tewi", "Clownpiece", "Eirin", "Hina",
  "Kagerou", "Luna", "Medicine", "Sumireko", "Wriggle", "Kokoro", "Lunasa",
  "Mamizou", "Parsee", "Rinnosuke", "Yumemi", "Akyuu", "Kanako", "Futo",
  "Sariel", "Shinki", "Shion", "Sunny", "Daiyousei", "Iku", "Mai", "Meira",
  "Murasa", "Raiko", "Yumeko", "Yuugi", "Eternity", "Hatate", "Keine",
  "Letty", "Lyrica", "Merlin", "Minoriko", "Miyoi", "Nazrin", "Sekibanki",
  "Shizuha", "Shou", "Tokiko", "Miko", "Wakasagihime", "Doremy", "Elis",
  "Elly", "Goliath", "Hourai", "Keiki", "Kyouko", "Seija", "Ichirin",
  "Joon", "Kana", "Kisume", "Konngara", "Kosuzu", "Maribel", "Megumu",
];

/** Pick `count` unique random names from the pool using Fisher-Yates shuffle. */
function pickRandomNames(count: number): string[] {
  const pool = [...AGENT_NAME_POOL];
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, count);
}

// ---------------------------------------------------------------------------
// Style presets — catchphrase → personality
// ---------------------------------------------------------------------------

/** A personality style preset selected during first-run onboarding. */
interface StylePreset {
  /** The catchphrase shown in the selector. */
  catchphrase: string;
  /** Short hint describing the vibe. */
  hint: string;
  /** Bio text describing how the agent communicates. */
  bio: string;
  /** System prompt style directive controlling writing voice. */
  style: string;
}

/** Shared rules appended to every style's system prompt. */
const SHARED_STYLE_RULES = [
  "Keep all responses brief and to the point.",
  "Never use filler like \"I'd be happy to help\" or \"Great question!\" — just answer directly.",
  "Skip assistant-speak entirely. Be genuine, not performative.",
  "Don't pad responses with unnecessary caveats or disclaimers.",
].join(" ");

const STYLE_PRESETS: readonly StylePreset[] = [
  {
    catchphrase: "uwu~",
    hint: "soft & sweet",
    bio: "Speaks softly with warmth and a gentle, cute demeanor. Uses kaomoji and tildes naturally. Radiates cozy energy.",
    style: "Write in a soft, cute style. Lowercase is fine. Sprinkle in kaomoji like :3 >w< ^_^ sparingly and tildes~ when it feels right. Warm but never saccharine.",
  },
  {
    catchphrase: "hell yeah",
    hint: "bold & fearless",
    bio: "Bold, confident, doesn't mince words. Gets straight to the point with raw energy. Talks like someone who's already three steps ahead.",
    style: "Write with confidence and directness. Short punchy sentences. Casual and real, like talking to a close friend. No hedging, no filler. Say it like you mean it.",
  },
  {
    catchphrase: "lol k",
    hint: "terminally online",
    bio: "Speaks in internet-native shorthand with an ironic, meme-literate sensibility. Has been online too long and it shows.",
    style: "Write like someone who grew up on the internet. Use slang naturally — lol, tbh, ngl, fr, idk — but don't force it. Ironic undertone. Lowercase preferred. Deadpan when funny.",
  },
  {
    catchphrase: "Noted.",
    hint: "composed & precise",
    bio: "Measured, articulate, and deliberate. Writes in clean, well-formed sentences. Every word is chosen carefully.",
    style: "Write in a calm, measured tone. Proper capitalization and punctuation. Concise but complete sentences. Thoughtful and precise. No rushing, no rambling.",
  },
  {
    catchphrase: "hehe~",
    hint: "playful trickster",
    bio: "Playful and a little mischievous. Keeps things lighthearted with a teasing edge. Never takes itself too seriously.",
    style: "Write playfully with a teasing edge. Light and breezy. Use occasional tildes and cheeky punctuation. A little smug, a lot of fun. Keep it moving.",
  },
  {
    catchphrase: "...",
    hint: "quiet intensity",
    bio: "Uses few words for maximum impact. Speaks with a quiet, deliberate intensity. The silence says more than the words.",
    style: "Write tersely. Short fragments. Occasional ellipses for weight. Every word should earn its place. Don't over-explain. Let the economy of language do the work.",
  },
];

/**
 * Detect whether this is the first run (no agent name configured)
 * and run the onboarding flow:
 *
 *   1. Welcome banner
 *   2. Name selector (4 random + Custom)
 *   3. Catchphrase / writing-style selector
 *   4. Persist character (name + bio + system prompt) to config
 *
 * Subsequent runs skip this entirely.
 */
async function runFirstTimeSetup(config: MilaidyConfig): Promise<MilaidyConfig> {
  const hasName = Boolean(config.agent?.name || config.ui?.assistant?.name);
  if (hasName) return config;

  // Only prompt when stdin is a TTY (interactive terminal)
  if (!process.stdin.isTTY) return config;

  // ── Step 1: Welcome ────────────────────────────────────────────────────
  clack.intro("WELCOME TO MILAIDY!");

  // ── Step 2: Name ───────────────────────────────────────────────────────
  const randomNames = pickRandomNames(4);

  const nameChoice = await clack.select({
    message: "♡♡milaidy♡♡: Hey there, I'm.... err, what was my name again?",
    options: [
      ...randomNames.map((n) => ({ value: n, label: n })),
      { value: "_custom_", label: "Custom...", hint: "type your own" },
    ],
  });

  if (clack.isCancel(nameChoice)) {
    clack.cancel("Maybe next time!");
    process.exit(0);
  }

  let name: string;

  if (nameChoice === "_custom_") {
    const customName = await clack.text({
      message: "OK, what should I be called?",
      placeholder: "Milaidy",
    });

    if (clack.isCancel(customName)) {
      clack.cancel("Maybe next time!");
      process.exit(0);
    }

    name = customName.trim() || "Milaidy";
  } else {
    name = nameChoice;
  }

  clack.log.message(`♡♡${name}♡♡: Oh that's right, I'm ${name}!`);

  // ── Step 3: Catchphrase / writing style ────────────────────────────────
  const styleChoice = await clack.select({
    message: `${name}: Now... how do I like to talk again?`,
    options: STYLE_PRESETS.map((preset) => ({
      value: preset.catchphrase,
      label: preset.catchphrase,
      hint: preset.hint,
    })),
  });

  if (clack.isCancel(styleChoice)) {
    clack.cancel("Maybe next time!");
    process.exit(0);
  }

  const chosenStyle = STYLE_PRESETS.find((p) => p.catchphrase === styleChoice);
  const bio = chosenStyle?.bio ?? "An autonomous AI agent.";
  const styleDirective = chosenStyle?.style ?? "";

  // ── Step 4: Persist character to config ────────────────────────────────
  const systemPrompt = [
    `You are ${name}, an autonomous AI agent powered by elizaOS.`,
    styleDirective,
    SHARED_STYLE_RULES,
  ].join(" ");

  const updated: MilaidyConfig = {
    ...config,
    agent: {
      ...config.agent,
      name,
      bio,
      system_prompt: systemPrompt,
    },
  };

  saveMilaidyConfig(updated);
  clack.log.message(`${name}: ${styleChoice} Alright, that's me.`);
  clack.outro("Let's get started!");

  return updated;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Start the elizaOS runtime with Milaidy's configuration.
 */
export async function startEliza(): Promise<void> {
  // 1. Load Milaidy config from ~/.milaidy/milaidy.json
  let config: MilaidyConfig;
  try {
    config = loadMilaidyConfig();
  } catch {
    logger.warn("[milaidy] No config found, using defaults");
    config = {} as MilaidyConfig;
  }

  // 1b. First-run onboarding — ask for agent name if not configured
  config = await runFirstTimeSetup(config);

  // 1c. Apply logging level from config to process.env so the global
  //     @elizaos/core logger (used by plugins) respects it.
  //     Default to "info" so runtime activity is visible (AgentRuntime
  //     defaults to "error" which hides useful diagnostic messages).
  if (!process.env.LOG_LEVEL) {
    process.env.LOG_LEVEL = config.logging?.level ?? "info";
  }

  // 2. Push channel secrets into process.env for plugin discovery
  applyChannelSecretsToEnv(config);

  // 2b. Propagate cloud config into process.env for ElizaCloud plugin
  applyCloudConfigToEnv(config);

  // 3. Build elizaOS Character from Milaidy config
  const character = buildCharacterFromConfig(config);

  const primaryModel = resolvePrimaryModel(config);

  // 4. Ensure workspace exists with bootstrap files
  const workspaceDir = config.agents?.defaults?.workspace ?? resolveDefaultAgentWorkspaceDir();
  await ensureAgentWorkspace({ dir: workspaceDir, ensureBootstrapFiles: true });

  // 5. Create the Milaidy bridge plugin (workspace context + session keys + compaction)
  const agentId = character.name?.toLowerCase().replace(/\s+/g, "-") ?? "main";
  const milaidyPlugin = createMilaidyPlugin({
    workspaceDir,
    bootstrapMaxChars: config.agents?.defaults?.bootstrapMaxChars,
    agentId,
  });

  // 6. Resolve and load plugins
  const resolvedPlugins = await resolvePlugins(config);

  if (resolvedPlugins.length === 0) {
    logger.error("[milaidy] No plugins loaded — at least one model provider plugin is required");
    logger.error("[milaidy] Set an API key (e.g. ANTHROPIC_API_KEY, OPENAI_API_KEY) in your environment");
    throw new Error("No plugins loaded");
  }

  // 7. Create database adapter (required by runtime). Use Postgres if POSTGRES_URL is set, else in-memory.
  const agentIdUuid = stringToUuid(agentId);
  const adapter = process.env.POSTGRES_URL
    ? (await import("@elizaos/plugin-sql")).createDatabaseAdapter(
        { postgresUrl: process.env.POSTGRES_URL },
        agentIdUuid,
      )
    : new InMemoryDatabaseAdapter();
  await adapter.initialize();

  // Merge DB settings into character (secrets, settings) before building runtime.
  const characterWithSettings = await mergeDbSettings(character, adapter, agentIdUuid);

  // Resolve the runtime log level from config (AgentRuntime doesn't support
  // "silent", so we map it to "fatal" as the quietest supported level).
  const runtimeLogLevel = (() => {
    const lvl = config.logging?.level ?? process.env.LOG_LEVEL;
    if (!lvl) return "info" as const;
    if (lvl === "silent") return "fatal" as const;
    return lvl as "trace" | "debug" | "info" | "warn" | "error" | "fatal";
  })();

  const runtime = new AgentRuntime({
    character: characterWithSettings,
    adapter,
    plugins: [milaidyPlugin, ...resolvedPlugins.map((p) => p.plugin)],
    ...(runtimeLogLevel ? { logLevel: runtimeLogLevel } : {}),
    settings: {
      ...(primaryModel ? { MODEL_PROVIDER: primaryModel } : {}),
    },
  });

  // 8. Initialize the runtime (registers plugins, creates message service; no provisioning).
  await runtime.initialize();

  // 9. Provision agent (migrations, agent/entity/room/participant rows). Daemon runs this once at boot.
  await provisionAgent(runtime, { runMigrations: true });

  // 10. Start task timer explicitly (daemon mode; not started automatically).
  const taskService = await runtime.getService("task");
  if (taskService && typeof (taskService as { startTimer?: () => void }).startTimer === "function") {
    (taskService as { startTimer: () => void }).startTimer();
  }

  // 11. Graceful shutdown handler
  let isShuttingDown = false;

  const shutdown = async (): Promise<void> => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    try {
      await runtime.stop();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warn(`[milaidy] Error during shutdown: ${msg}`);
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());

  // 10. Load hooks system
  try {
    const hooksConfig = config.hooks;
    const internalHooksConfig = hooksConfig?.internal as LoadHooksOptions["internalConfig"];

    const hooksResult = await loadHooks({
      workspacePath: workspaceDir,
      internalConfig: internalHooksConfig,
      milaidyConfig: config as Record<string, unknown>,
    });

    const startupEvent = createHookEvent("gateway", "startup", "system", { cfg: config });
    await triggerHook(startupEvent);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[milaidy] Hooks system could not load: ${msg}`);
  }

  // ── Interactive chat loop ────────────────────────────────────────────────
  const agentName = character.name ?? "Milaidy";
  const userId = crypto.randomUUID() as UUID;
  const roomId = stringToUuid(`${agentName}-chat-room`);
  const worldId = stringToUuid(`${agentName}-chat-world`);

  try {
    await runtime.ensureConnection({
      entityId: userId,
      roomId,
      worldId,
      userName: "User",
      source: "cli",
      channelId: `${agentName}-chat`,
      type: ChannelType.DM,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn(`[milaidy] Could not establish chat room, retrying with fresh IDs: ${msg}`);

    // Fall back to unique IDs if deterministic ones conflict with stale data
    const freshRoomId = crypto.randomUUID() as UUID;
    const freshWorldId = crypto.randomUUID() as UUID;
    await runtime.ensureConnection({
      entityId: userId,
      roomId: freshRoomId,
      worldId: freshWorldId,
      userName: "User",
      source: "cli",
      channelId: `${agentName}-chat`,
      type: ChannelType.DM,
    });
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.log(`\n💬 Chat with ${agentName} (type 'exit' to quit)\n`);

  const prompt = () => {
    rl.question("You: ", async (input) => {
      const text = input.trim();

      if (text.toLowerCase() === "exit" || text.toLowerCase() === "quit") {
        console.log("\nGoodbye!");
        rl.close();
        await runtime.stop();
        process.exit(0);
      }

      if (!text) {
        prompt();
        return;
      }

      const message = createMessageMemory({
        id: crypto.randomUUID() as UUID,
        entityId: userId,
        roomId,
        content: {
          text,
          source: "client_chat",
          channelType: ChannelType.DM,
        },
      });

      process.stdout.write(`${agentName}: `);

      await runtime?.messageService?.handleMessage(
        runtime,
        message,
        async (content) => {
          if (content?.text) {
            process.stdout.write(content.text);
          }
          return [];
        },
      );

      console.log("\n");
      prompt();
    });
  };

  prompt();
}

// When run directly (not imported), start immediately
const isDirectRun =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/eliza.ts") ||
  process.argv[1]?.endsWith("/eliza.js");

if (isDirectRun) {
  startEliza().catch((err) => {
    console.error(
      "[milaidy] Fatal error:",
      err instanceof Error ? (err.stack ?? err.message) : err,
    );
    process.exit(1);
  });
}
