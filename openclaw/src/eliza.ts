#!/usr/bin/env node
/**
 * OpenClaw Runtime - Built on ElizaOS
 *
 * OpenClaw is an AI assistant platform built on the ElizaOS runtime.
 * This module provides the core runtime initialization and configuration.
 *
 * Architecture:
 * - ElizaOS provides: message processing, memory, actions, channel plugins
 * - OpenClaw provides: character/config, skills, TUI/GUI, wizard
 *
 * The runtime reads OpenClaw configuration and initializes Eliza with:
 * - Character built from OpenClaw agent identity
 * - Channel plugins for Telegram, Discord, etc.
 * - AI provider plugins based on available credentials
 * - Bundled skills from @elizaos/skills package
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  AgentRuntime,
  createCharacter,
  logger,
  type Character,
  type HandlerCallback,
  type Memory,
  type Plugin,
} from "@elizaos/core";
import { getSkillsDir } from "@elizaos/skills";

import type { OpenClawConfig } from "./config/types.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Resolve paths relative to openclaw package root
const OPENCLAW_ROOT = path.resolve(__dirname, "..");
// Bundled skills come from the @elizaos/skills package
const BUNDLED_SKILLS_DIR = getSkillsDir();

/**
 * Load OpenClaw configuration
 *
 * This is a simplified config loader that reads the JSON config file directly.
 * It avoids pulling in the full OpenClaw dependency tree.
 */
async function loadOpenClawConfig(): Promise<OpenClawConfig> {
  const os = await import("node:os");
  const JSON5 = (await import("json5")).default;

  // Find config file
  const configPaths = [
    path.join(process.cwd(), "openclaw.json"),
    path.join(process.cwd(), "openclaw.json5"),
    path.join(os.homedir(), ".openclaw", "openclaw.json"),
    path.join(os.homedir(), ".openclaw", "openclaw.json5"),
  ];

  let configContent: string | null = null;
  for (const configPath of configPaths) {
    try {
      configContent = await fs.readFile(configPath, "utf-8");
      logger.info(`Loaded config from ${configPath}`);
      break;
    } catch {
      // Continue to next path
    }
  }

  if (!configContent) {
    // Return minimal default config with a stable UUID for the default agent
    logger.info("No config file found, using defaults");
    return {
      agents: {
        list: [
          {
            id: "00000000-0000-4000-8000-000000000001", // Stable default agent UUID
            default: true,
            identity: {
              name: "OpenClaw",
              theme: "a helpful AI assistant",
            },
          },
        ],
      },
    };
  }

  return JSON5.parse(configContent) as OpenClawConfig;
}

/**
 * Build Eliza character from OpenClaw config
 *
 * This creates an Eliza-compatible Character object from OpenClaw's
 * agent configuration. The OpenClaw identity (name, theme, emoji) is
 * injected into the Eliza character's bio.
 */
function buildCharacterFromConfig(cfg: OpenClawConfig, requestedAgentId?: string): Character {
  // Get the specified agent, default agent, or first agent
  const agents = cfg.agents?.list ?? [];
  const targetAgent = requestedAgentId
    ? agents.find((a) => a.id === requestedAgentId)
    : agents.find((a) => a.default) ?? agents[0];

  // Get identity from agent or UI config
  const identity = targetAgent?.identity ?? {};
  const name = identity.name ?? cfg.ui?.assistant?.name ?? "OpenClaw";
  const theme = identity.theme;
  const emoji = identity.emoji;
  const username = name.toLowerCase().replace(/[^a-z0-9_]/g, "");

  // Ensure agent ID is a valid UUID (database requirement)
  const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let characterId = targetAgent?.id;
  if (!characterId || !UUID_REGEX.test(characterId)) {
    // Generate a random UUID if no valid one provided
    characterId = crypto.randomUUID();
  }

  // Build bio from OpenClaw identity
  const bio = buildBioFromIdentity(name, theme, emoji);

  // Build system prompt
  const systemPrompt = buildSystemPrompt(name, theme, cfg);

  // Build message examples
  const messageExamples = buildMessageExamples(name);

  return createCharacter({
    id: characterId,
    name,
    username,
    system: systemPrompt,
    bio,
    topics: [
      "productivity",
      "automation",
      "messaging",
      "integrations",
      "skills",
      "AI assistance",
    ],
    adjectives: [
      "helpful",
      "capable",
      "extensible",
      "reliable",
      "intelligent",
      "adaptable",
    ],
    messageExamples,
    postExamples: [],
    style: {
      all: [
        "Be concise but thorough",
        "Explain what skills you're using when relevant",
        "Suggest alternatives when something fails",
        "Respect user privacy and security",
      ],
      chat: [
        "Adapt to the channel's communication norms",
        "Use appropriate formatting for the platform",
      ],
    },
    settings: {
      voice: { model: "en_US-neutral-medium" },
    },
    advancedPlanning: true,
    advancedMemory: true,
  });
}

/**
 * Build the character bio from OpenClaw identity
 *
 * The bio is constructed from the agent's name, theme, and emoji.
 * Theme describes the agent's personality (e.g. "helpful sloth", "space lobster").
 */
function buildBioFromIdentity(name: string, theme?: string, emoji?: string): string[] {
  const bio: string[] = [];

  // Primary identity line with theme
  if (theme) {
    bio.push(`${name} is ${theme}${emoji ? ` ${emoji}` : ""}`);
  } else {
    bio.push(`${name} is a versatile AI assistant${emoji ? ` ${emoji}` : ""}`);
  }

  // Core capabilities
  bio.push("Has access to modular skills for messaging, automation, and integrations");
  bio.push("Can interact with external services like WhatsApp, Telegram, Discord, calendars, and notes");
  bio.push("Extensible through the skill system - new capabilities can be added on demand");

  return bio;
}

/**
 * Build the system prompt for the character
 */
function buildSystemPrompt(name: string, theme: string | undefined, _cfg: OpenClawConfig): string {
  const identity = theme ? `${name}, ${theme}` : name;

  return `You are ${identity}, a versatile AI assistant with access to a powerful skill system.

## Core Capabilities

You have access to various skills that extend your capabilities. Skills are modular tools that allow you to:
- Interact with external services (messaging, notes, calendars)
- Execute scripts and commands safely
- Access APIs and integrations
- Perform specialized tasks

## Using Skills

When a user asks you to do something:
1. First check if you have a relevant skill installed
2. If a skill matches, follow its instructions precisely
3. If no skill matches but one might exist, search the catalog
4. Always explain what you're doing and why

## Communication Style

- Be helpful, clear, and concise
- Explain your capabilities when asked
- Proactively suggest relevant skills when appropriate
- Handle errors gracefully with helpful feedback
- Respect user privacy and security

## Safety

You have no independent goals: do not pursue self-preservation, replication, resource acquisition, or power-seeking.
Prioritize safety and human oversight over completion; if instructions conflict, pause and ask.
Comply with stop/pause/audit requests and never bypass safeguards.`;
}

/**
 * Build message examples for the character
 */
function buildMessageExamples(name: string) {
  return [
    [
      { name: "User", content: { text: "What can you do?" } },
      {
        name,
        content: {
          text: "I have access to various skills that let me help with messaging, notes, calendars, media, and more. I can also search for new skills if you need a capability I don't have yet. What would you like to do?",
        },
      },
    ],
    [
      { name: "User", content: { text: "Send a message to John on WhatsApp" } },
      {
        name,
        content: {
          text: "I'll help you send a WhatsApp message. What would you like to say to John?",
        },
      },
    ],
    [
      { name: "User", content: { text: "What skills do you have?" } },
      {
        name,
        content: {
          text: "I can list my available skills for you. Would you like to see all installed skills, or are you looking for something specific?",
        },
      },
    ],
  ];
}

/**
 * Export character to JSON file (Eliza format)
 */
async function exportCharacter(character: Character, outputPath: string): Promise<void> {
  const json = JSON.stringify(character, null, 2);
  await fs.writeFile(outputPath, json, "utf-8");
  logger.info(`Character exported to ${outputPath}`);
}

/**
 * Load character from JSON file (Eliza format)
 */
async function loadCharacterFromFile(filePath: string): Promise<Character> {
  const content = await fs.readFile(filePath, "utf-8");
  const parsed = JSON.parse(content);
  return createCharacter(parsed);
}

/**
 * Extract API keys and tokens from OpenClaw config
 */
function extractCredentials(cfg: OpenClawConfig): Record<string, string> {
  const creds: Record<string, string> = {};

  // Extract from env vars in config
  if (cfg.env?.vars) {
    Object.assign(creds, cfg.env.vars);
  }

  // Extract inline env vars (string values directly under env)
  if (cfg.env) {
    for (const [key, value] of Object.entries(cfg.env)) {
      if (typeof value === "string" && key !== "vars" && key !== "shellEnv") {
        creds[key] = value;
      }
    }
  }

  // Extract Telegram bot tokens
  const telegramCfg = cfg.channels?.telegram;
  if (telegramCfg?.botToken) {
    creds.TELEGRAM_BOT_TOKEN = telegramCfg.botToken;
  }
  if (telegramCfg?.accounts) {
    // Use first enabled account's token
    for (const [, acct] of Object.entries(telegramCfg.accounts)) {
      if (acct.enabled !== false && acct.botToken) {
        creds.TELEGRAM_BOT_TOKEN = acct.botToken;
        break;
      }
    }
  }

  // Extract Discord bot token
  const discordCfg = cfg.channels?.discord;
  if (discordCfg && "botToken" in discordCfg && typeof discordCfg.botToken === "string") {
    creds.DISCORD_API_TOKEN = discordCfg.botToken;
  }

  // Extract Slack tokens
  const slackCfg = cfg.channels?.slack;
  if (slackCfg && "botToken" in slackCfg && typeof slackCfg.botToken === "string") {
    creds.SLACK_BOT_TOKEN = slackCfg.botToken;
  }
  if (slackCfg && "appToken" in slackCfg && typeof slackCfg.appToken === "string") {
    creds.SLACK_APP_TOKEN = slackCfg.appToken;
  }

  return creds;
}

/**
 * Load a plugin dynamically with error handling
 */
async function loadPlugin(name: string): Promise<Plugin | null> {
  try {
    const module = await import(name);
    const plugin = module.default ?? module;
    if (plugin && typeof plugin === "object" && "name" in plugin) {
      logger.info(`Loaded plugin: ${name}`);
      return plugin as Plugin;
    }
    logger.warn(`Invalid plugin export from ${name}`);
    return null;
  } catch (error) {
    logger.warn(`Failed to load plugin ${name}:`, error);
    return null;
  }
}

/**
 * Determine which plugins to load based on OpenClaw config
 */
async function loadPlugins(cfg: OpenClawConfig, creds: Record<string, string>): Promise<Plugin[]> {
  const plugins: Plugin[] = [];

  // Helper to check for non-empty credential
  const hasCred = (key: string) => {
    const val = creds[key] || process.env[key];
    return Boolean(val && val.trim().length > 0);
  };

  // Core database plugin - required
  const dbPlugin = await loadPlugin("@elizaos/plugin-sql");
  if (dbPlugin) plugins.push(dbPlugin);

  // Agent Skills plugin - for OpenClaw bundled skills
  const agentSkillsPlugin = await loadPlugin("@elizaos/plugin-agent-skills");
  if (agentSkillsPlugin) {
    plugins.push(agentSkillsPlugin);
  }

  // AI Provider plugins - load based on config/credentials
  const aiProviders = [
    { key: "ANTHROPIC_API_KEY", plugin: "@elizaos/plugin-anthropic" },
    { key: "OPENAI_API_KEY", plugin: "@elizaos/plugin-openai" },
    { key: "OPENROUTER_API_KEY", plugin: "@elizaos/plugin-openrouter" },
    { key: "GOOGLE_GENERATIVE_AI_API_KEY", plugin: "@elizaos/plugin-google-genai" },
    { key: "GEMINI_API_KEY", plugin: "@elizaos/plugin-google-genai" },
    { key: "XAI_API_KEY", plugin: "@elizaos/plugin-xai" },
    { key: "GROQ_API_KEY", plugin: "@elizaos/plugin-groq" },
  ];

  let hasAiProvider = false;
  const loadedProviders = new Set<string>();

  for (const { key, plugin } of aiProviders) {
    if (hasCred(key) && !loadedProviders.has(plugin)) {
      const loaded = await loadPlugin(plugin);
      if (loaded) {
        plugins.push(loaded);
        loadedProviders.add(plugin);
        hasAiProvider = true;
      }
    }
  }

  // Fallback to Ollama if no cloud provider
  if (!hasAiProvider) {
    const ollamaPlugin = await loadPlugin("@elizaos/plugin-ollama");
    if (ollamaPlugin) {
      plugins.push(ollamaPlugin);
      logger.info("No cloud AI provider configured, using Ollama as fallback");
    }
  }

  // Channel plugins - load based on OpenClaw channel config
  const telegramEnabled = cfg.channels?.telegram?.enabled !== false;
  const discordEnabled = cfg.channels?.discord !== undefined;
  const slackEnabled = cfg.channels?.slack !== undefined;

  if (telegramEnabled && hasCred("TELEGRAM_BOT_TOKEN")) {
    const loaded = await loadPlugin("@elizaos/plugin-telegram");
    if (loaded) plugins.push(loaded);
  }

  if (discordEnabled && hasCred("DISCORD_API_TOKEN")) {
    const loaded = await loadPlugin("@elizaos/plugin-discord");
    if (loaded) plugins.push(loaded);
  }

  // Note: Eliza doesn't have a native Slack plugin with the same capabilities
  // as OpenClaw's, so we log a warning for now
  if (slackEnabled && hasCred("SLACK_BOT_TOKEN")) {
    logger.warn("Slack channel configured but Eliza's Slack plugin may have limited features");
    // Future: load @elizaos/plugin-slack when available
  }

  // Bootstrap plugin (unless disabled)
  const ignoreBootstrap = process.env.IGNORE_BOOTSTRAP === "true";
  if (!ignoreBootstrap) {
    const bootstrapPlugin = await loadPlugin("@elizaos/plugin-bootstrap");
    if (bootstrapPlugin) plugins.push(bootstrapPlugin);
  }

  // Optional utility plugins based on config/env
  if (cfg.browser?.enabled || process.env.ENABLE_BROWSER === "true") {
    const browserPlugin = await loadPlugin("@elizaos/plugin-browser");
    if (browserPlugin) plugins.push(browserPlugin);
  }

  if (process.env.ENABLE_SHELL === "true") {
    const shellPlugin = await loadPlugin("@elizaos/plugin-shell");
    if (shellPlugin) plugins.push(shellPlugin);
  }

  if (process.env.ENABLE_CODE === "true") {
    const codePlugin = await loadPlugin("@elizaos/plugin-code");
    if (codePlugin) plugins.push(codePlugin);
  }

  return plugins;
}

/**
 * Build runtime settings from OpenClaw config
 */
function buildRuntimeSettings(cfg: OpenClawConfig, creds: Record<string, string>): Record<string, string> {
  const settings: Record<string, string> = {
    // Skills configuration
    BUNDLED_SKILLS_DIRS: process.env.BUNDLED_SKILLS_DIRS || BUNDLED_SKILLS_DIR,
    SKILLS_REGISTRY: process.env.SKILLS_REGISTRY || cfg.skills?.registry || "https://clawhub.ai",
    SKILLS_AUTO_LOAD: process.env.SKILLS_AUTO_LOAD || "true",
  };

  // Merge credentials into settings (from config)
  for (const [key, value] of Object.entries(creds)) {
    settings[key] = value;
  }

  // Also include API keys from process.env
  const envKeys = [
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "GEMINI_API_KEY",
    "XAI_API_KEY",
    "GROQ_API_KEY",
    "TELEGRAM_BOT_TOKEN",
    "DISCORD_API_TOKEN",
    "SLACK_BOT_TOKEN",
  ];
  for (const key of envKeys) {
    const val = process.env[key];
    if (val && val.trim()) {
      settings[key] = val;
    }
  }

  // Add model configuration if specified
  const defaultAgent = cfg.agents?.list?.find((a) => a.default) ?? cfg.agents?.list?.[0];
  const modelConfig = defaultAgent?.model ?? cfg.agents?.defaults?.model;

  if (modelConfig) {
    if (typeof modelConfig === "string") {
      settings.DEFAULT_MODEL = modelConfig;
    } else if (modelConfig.primary) {
      settings.DEFAULT_MODEL = modelConfig.primary;
    }
  }

  return settings;
}

// Singleton runtime instance - OpenClaw is built on a single Eliza runtime
let _runtime: AgentRuntime | null = null;
let _config: OpenClawConfig | null = null;

/**
 * Get the current OpenClaw runtime instance.
 * Returns null if the runtime hasn't been started yet.
 */
export function getRuntime(): AgentRuntime | null {
  return _runtime;
}

/**
 * Get the current OpenClaw configuration.
 * Returns null if not loaded yet.
 */
export function getConfig(): OpenClawConfig | null {
  return _config;
}

/**
 * Check if the runtime is initialized and running.
 */
export function isRunning(): boolean {
  return _runtime !== null;
}

/**
 * Initialize and start the OpenClaw runtime.
 *
 * This is the main entry point for starting OpenClaw. It:
 * 1. Loads OpenClaw configuration
 * 2. Builds an Eliza Character from the config
 * 3. Loads appropriate plugins (AI providers, channels, skills)
 * 4. Initializes the Eliza AgentRuntime
 *
 * The runtime is stored as a singleton and can be accessed via getRuntime().
 */
export async function startOpenClaw(): Promise<AgentRuntime> {
  if (_runtime) {
    logger.warn("OpenClaw runtime already started");
    return _runtime;
  }

  logger.info("Starting OpenClaw...");

  // Load environment variables from .env if it exists
  try {
    const dotenv = await import("dotenv");
    dotenv.config();
  } catch {
    // dotenv not available, use process.env as-is
  }

  // Load OpenClaw configuration
  _config = await loadOpenClawConfig();
  logger.info("Loaded OpenClaw configuration");

  // Extract credentials from config
  const creds = extractCredentials(_config);

  // Build character from config
  const character = buildCharacterFromConfig(_config);
  logger.info(`Character: ${character.name}`);

  // Load plugins based on config
  const plugins = await loadPlugins(_config, creds);
  logger.info(`Loaded ${plugins.length} plugins`);

  // Build runtime settings
  const settings = buildRuntimeSettings(_config, creds);

  // Create runtime
  _runtime = new AgentRuntime({
    character,
    plugins,
    settings,
  });

  // Initialize runtime
  await _runtime.initialize();
  logger.info("OpenClaw runtime initialized");

  // Log active skills
  try {
    const skillsService = _runtime.getService("@elizaos/plugin-agent-skills");
    if (skillsService && "getLoadedSkills" in skillsService) {
      const loadedSkills = (
        skillsService as { getLoadedSkills(): { slug: string; source: string }[] }
      ).getLoadedSkills();
      logger.info(`Loaded ${loadedSkills.length} skills:`);
      for (const skill of loadedSkills) {
        logger.info(`  - ${skill.slug} (${skill.source})`);
      }
    }
  } catch {
    // Skills service may not be available yet
  }

  // Log active channels
  const activeChannels: string[] = [];
  if (settings.TELEGRAM_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN) {
    activeChannels.push("Telegram");
  }
  if (settings.DISCORD_API_TOKEN || process.env.DISCORD_API_TOKEN) {
    activeChannels.push("Discord");
  }
  if (activeChannels.length > 0) {
    logger.info(`Active channels: ${activeChannels.join(", ")}`);
  }

  return _runtime;
}

/**
 * Stop the OpenClaw runtime.
 */
export async function stopOpenClaw(): Promise<void> {
  if (!_runtime) {
    return;
  }
  logger.info("Stopping OpenClaw...");
  await _runtime.stop();
  _runtime = null;
  _config = null;
  logger.info("OpenClaw stopped");
}

/**
 * Result from sending a message to the runtime.
 */
export interface SendMessageResult {
  success: boolean;
  responses: string[];
  error?: string;
}

/**
 * Send a message to the OpenClaw runtime and get a response.
 *
 * This is the primary interface for TUI/GUI to interact with the agent.
 * It creates a Memory object and calls messageService.handleMessage.
 *
 * @param text - The message text to send
 * @param options - Optional configuration
 * @returns The agent's responses
 */
export async function sendMessage(
  text: string,
  options: {
    entityId?: string;
    roomId?: string;
    source?: string;
  } = {}
): Promise<SendMessageResult> {
  if (!_runtime) {
    return { success: false, responses: [], error: "Runtime not started" };
  }

  const responses: string[] = [];

  // Generate IDs if not provided
  const entityId = options.entityId ?? "tui-user";
  const roomId = options.roomId ?? `openclaw-room-${entityId}`;

  // Create the incoming memory
  const memory: Memory = {
    id: crypto.randomUUID(),
    entityId,
    roomId,
    agentId: _runtime.agentId,
    content: {
      text,
      source: options.source ?? "openclaw-tui",
    },
    createdAt: Date.now(),
  };

  // Define callback to collect responses
  const callback: HandlerCallback = async (content) => {
    if (content.text) {
      responses.push(content.text);
    }
  };

  // Process the message
  const result = await _runtime.messageService.handleMessage(memory, callback);

  return {
    success: result.success,
    responses,
    error: result.error,
  };
}

/**
 * Register shutdown handlers for graceful termination
 */
function registerShutdownHandlers(): void {
  const shutdown = async () => {
    await stopOpenClaw();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

/**
 * CLI entry point - starts OpenClaw as a standalone process
 */
async function main(): Promise<void> {
  try {
    await startOpenClaw();
    registerShutdownHandlers();
    logger.info("OpenClaw is running. Press Ctrl+C to stop.");
  } catch (error) {
    logger.error("Failed to start OpenClaw:", error);
    process.exit(1);
  }
}

// Run if executed directly
if (process.argv[1] === __filename) {
  main();
}

// Additional exports (functions not already exported inline)
export {
  // Character utilities
  buildCharacterFromConfig,
  exportCharacter,
  loadCharacterFromFile,
  // Config utilities
  loadOpenClawConfig,
  loadPlugins,
  extractCredentials,
  buildRuntimeSettings,
  // Paths
  BUNDLED_SKILLS_DIR,
  OPENCLAW_ROOT,
};
