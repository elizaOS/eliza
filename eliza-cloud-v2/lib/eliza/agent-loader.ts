import type { Character, Plugin, Provider, Action } from "@elizaos/core";
import { elizaOSCloudPlugin } from "@elizaos/plugin-elizacloud";
import { memoryPlugin } from "@elizaos/plugin-memory";
import { elevenLabsPlugin } from "@elizaos/plugin-elevenlabs";
import mcpPlugin from "@elizaos/plugin-mcp";
import { cloudBootstrapPlugin } from "./plugin-cloud-bootstrap";
import { affiliatePlugin } from "./plugin-affiliate";
import { chatPlaygroundPlugin } from "./plugin-chat-playground";
import { characterBuilderPlugin } from "./plugin-character-builder";
import { charactersService } from "@/lib/services/characters";
import { memoriesRepository } from "@/db/repositories/agents/memories";
import type { ElizaCharacter } from "@/lib/types";
import defaultAgent from "./agent";
import { getElizaCloudApiUrl, buildElevenLabsSettings } from "./config";
import { logger } from "@/lib/utils/logger";
import {
  AgentMode,
  AGENT_MODE_PLUGINS,
  SETTINGS_PLUGIN_MAP,
  getConditionalPlugins,
  requiresAssistantMode,
  hasAffiliateData,
} from "./agent-mode-types";

// Plugin cache - preloaded at module init to eliminate dynamic import latency
let _knowledgePlugin: Plugin | null = null;
let _webSearchPlugin: Plugin | null = null;
let _pluginsPreloading = false;

async function preloadPlugins(): Promise<void> {
  if (_pluginsPreloading) return;
  _pluginsPreloading = true;

  try {
    // Only preload web-search plugin (local version)
    // Knowledge plugin is loaded on-demand when documents exist
    const webSearchModule = await import("./plugin-web-search/src").catch((e) => {
      logger.warn("[AgentLoader] Failed to preload local web-search plugin:", e);
      return null;
    });

    if (webSearchModule) {
      _webSearchPlugin = webSearchModule.webSearchPlugin;
    }

    logger.info("[AgentLoader] ⚡ Web search plugin preloaded");
  } catch (e) {
    logger.error("[AgentLoader] Plugin preload failed:", e);
  }
}

preloadPlugins();

export type ModeUpgradeReason =
  | "settings_plugin"
  | "explicit_plugin"
  | "has_knowledge"
  | "none";

export interface ModeResolution {
  mode: AgentMode;
  upgradeReason: ModeUpgradeReason;
  /** Document count from mode resolution - reuse to avoid duplicate DB query */
  documentCount?: number;
}

function hasExplicitSettingsPlugin(characterPlugins: string[]): boolean {
  const settingsPluginNames: string[] = Object.values(SETTINGS_PLUGIN_MAP);
  return characterPlugins.some((p) => settingsPluginNames.includes(p));
}

/** Determines effective agent mode, upgrading to ASSISTANT when advanced features needed. */
async function resolveEffectiveMode(
  requestedMode: AgentMode,
  characterId: string,
  characterSettings: Record<string, unknown>,
  characterPlugins: string[],
): Promise<ModeResolution> {
  // BUILD mode is never upgraded - it's a specific workflow
  if (requestedMode === AgentMode.BUILD) {
    return { mode: requestedMode, upgradeReason: "none", documentCount: 0 };
  }

  // Query document count once - needed for multiple checks and plugin resolution
  const documentCount = await memoriesRepository.countByType(
    characterId,
    "documents",
    characterId,
  );

  // Already ASSISTANT mode - no upgrade needed
  if (requestedMode === AgentMode.ASSISTANT) {
    return { mode: requestedMode, upgradeReason: "none", documentCount };
  }

  if (requiresAssistantMode(characterSettings)) {
    return {
      mode: AgentMode.ASSISTANT,
      upgradeReason: "settings_plugin",
      documentCount,
    };
  }

  if (hasExplicitSettingsPlugin(characterPlugins)) {
    return {
      mode: AgentMode.ASSISTANT,
      upgradeReason: "explicit_plugin",
      documentCount,
    };
  }

  if (documentCount > 0) {
    return {
      mode: AgentMode.ASSISTANT,
      upgradeReason: "has_knowledge",
      documentCount,
    };
  }

  return { mode: requestedMode, upgradeReason: "none", documentCount };
}

async function getKnowledgePlugin(): Promise<Plugin> {
  if (_knowledgePlugin) return _knowledgePlugin;

  // Fallback to dynamic import if preload hasn't completed
  const { knowledgePluginCore } = await import("@elizaos/plugin-knowledge");
  _knowledgePlugin = knowledgePluginCore;
  return knowledgePluginCore;
}

async function getWebSearchPlugin(): Promise<Plugin> {
  if (_webSearchPlugin) return _webSearchPlugin;

  // Fallback to dynamic import if preload hasn't completed
  // Use local web-search plugin
  const { webSearchPlugin } = await import("./plugin-web-search/src");
  _webSearchPlugin = webSearchPlugin;
  return webSearchPlugin;
}

/** Cast external plugin to local Plugin type for cross-version compatibility. */
function asPlugin<T extends { name: string; description: string }>(
  plugin: T,
): Plugin {
  return plugin as Plugin;
}

const AVAILABLE_PLUGINS: Record<string, Plugin> = {
  "@elizaos/plugin-elizacloud": asPlugin(elizaOSCloudPlugin),
  "@elizaos/plugin-elevenlabs": asPlugin(elevenLabsPlugin),
  "@elizaos/plugin-memory": asPlugin(memoryPlugin),
  "@elizaos/plugin-mcp": asPlugin(mcpPlugin),
  "@eliza-cloud/plugin-assistant": cloudBootstrapPlugin,
  "@eliza-cloud/plugin-affiliate": affiliatePlugin,
  "@eliza-cloud/plugin-chat-playground": chatPlaygroundPlugin,
  "@eliza-cloud/plugin-character-builder": characterBuilderPlugin,
};

export class AgentLoader {
  async loadCharacter(
    characterId: string,
    agentMode: AgentMode,
    options?: { webSearchEnabled?: boolean },
  ): Promise<{
    character: Character;
    plugins: Plugin[];
    modeResolution: ModeResolution;
  }> {
    const dbCharacter = await charactersService.getById(characterId);
    if (!dbCharacter) {
      throw new Error(`Character not found: ${characterId}`);
    }

    const elizaCharacter = charactersService.toElizaCharacter(dbCharacter);
    const character = this.buildCharacter(elizaCharacter);
    const characterSettings = (elizaCharacter.settings ?? {}) as Record<
      string,
      unknown
    >;
    const characterPlugins = elizaCharacter.plugins || [];

    if (options?.webSearchEnabled) {
      characterSettings.webSearch = { enabled: true };
    }

    const modeResolution = await resolveEffectiveMode(
      agentMode,
      characterId,
      characterSettings,
      characterPlugins,
    );

    const hasKnowledge = (modeResolution.documentCount ?? 0) > 0;

    const plugins = await this.resolvePlugins(
      modeResolution.mode,
      characterPlugins,
      characterSettings,
      { hasKnowledge },
    );
    return { character, plugins, modeResolution };
  }

  async getDefaultCharacter(
    agentMode: AgentMode,
    options?: { webSearchEnabled?: boolean },
  ): Promise<{
    character: Character;
    plugins: Plugin[];
    modeResolution: ModeResolution;
  }> {
    // Default character has no capabilities that require mode upgrade
    const modeResolution: ModeResolution = { mode: agentMode, upgradeReason: "none" };
    const characterSettings: Record<string, unknown> = {};
    if (options?.webSearchEnabled) {
      characterSettings.webSearch = { enabled: true };
    }
    const plugins = await this.resolvePlugins(agentMode, [], characterSettings);
    return { character: defaultAgent.character, plugins, modeResolution };
  }

  private buildCharacter(elizaCharacter: ElizaCharacter): Character {
    const characterId =
      elizaCharacter.id || "b850bc30-45f8-0041-a00a-83df46d8555d";
    const charSettings = (elizaCharacter.settings || {}) as Record<
      string,
      unknown
    >;

    const settings: Record<
      string,
      string | boolean | number | Record<string, unknown>
    > = {
      ...charSettings,
      POSTGRES_URL: process.env.DATABASE_URL!,
      DATABASE_URL: process.env.DATABASE_URL!,
      ELIZAOS_CLOUD_BASE_URL: getElizaCloudApiUrl(),
      // ElevenLabs settings (shared config)
      ...buildElevenLabsSettings(charSettings),
      ...(elizaCharacter.avatarUrl || elizaCharacter.avatar_url
        ? { avatarUrl: elizaCharacter.avatarUrl || elizaCharacter.avatar_url }
        : {}),
    };

    return {
      id: characterId as `${string}-${string}-${string}-${string}-${string}`,
      name: elizaCharacter.name,
      username: elizaCharacter.username,
      plugins: elizaCharacter.plugins || [],
      settings,
      system: elizaCharacter.system,
      bio: elizaCharacter.bio,
      messageExamples: elizaCharacter.messageExamples,
      postExamples: elizaCharacter.postExamples,
      topics: elizaCharacter.topics,
      adjectives: elizaCharacter.adjectives,
      knowledge: elizaCharacter.knowledge,
      style: elizaCharacter.style,
      templates: elizaCharacter.templates,
    };
  }

  private async resolvePlugins(
    agentMode: AgentMode,
    characterPlugins: string[],
    characterSettings: Record<string, unknown>,
    options?: { hasKnowledge?: boolean },
  ): Promise<Plugin[]> {
    const plugins: Plugin[] = [];
    const isAffiliate = hasAffiliateData(characterSettings);

    const conditionalPlugins = isAffiliate
      ? []
      : getConditionalPlugins(characterSettings);

    const modePlugins = AGENT_MODE_PLUGINS[agentMode].map((pluginName) => {
      if (isAffiliate && pluginName === "@eliza-cloud/plugin-assistant") {
        return "@eliza-cloud/plugin-affiliate";
      }
      return pluginName;
    });

    const allPluginNames = [
      ...modePlugins,
      ...characterPlugins,
      ...conditionalPlugins,
    ];

    // Load knowledge plugin for ASSISTANT mode to enable both:
    // - Knowledge queries (if documents exist)
    // - Uploading new documents (even if none exist yet)
    if (options?.hasKnowledge || agentMode === AgentMode.ASSISTANT) {
      allPluginNames.push("@elizaos/plugin-knowledge");
      logger.info(
        `[AgentLoader] Loading knowledge plugin - ${options?.hasKnowledge ? "documents found" : "ASSISTANT mode (enables uploads)"}`
      );
    }

    for (const pluginName of allPluginNames) {
      if (pluginName === "@elizaos/plugin-knowledge") {
        const knowledgePlugin = await getKnowledgePlugin();
        if (!plugins.includes(knowledgePlugin)) plugins.push(knowledgePlugin);
        continue;
      }

      if (pluginName === "@elizaos/plugin-web-search") {
        const webSearchPlugin = await getWebSearchPlugin();
        if (!plugins.includes(webSearchPlugin)) plugins.push(webSearchPlugin);
        continue;
      }

      const plugin = AVAILABLE_PLUGINS[pluginName];
      if (plugin && !plugins.includes(plugin)) {
        plugins.push(plugin);
      }
    }

    return plugins;
  }

  getProvidersAndActions(plugins: Plugin[]): {
    providers: Provider[];
    actions: Action[];
  } {
    return {
      providers: plugins.flatMap((p) => p.providers || []).filter(Boolean),
      actions: plugins.flatMap((p) => p.actions || []).filter(Boolean),
    };
  }
}

// Export singleton instance
export const agentLoader = new AgentLoader();
