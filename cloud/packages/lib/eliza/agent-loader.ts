import {
  type Action,
  type Character,
  type Plugin,
  type Provider,
  parseCharacter,
} from "@elizaos/core";
import { elevenLabsPlugin } from "@elizaos/plugin-elevenlabs";
import { elizaOSCloudPlugin } from "@elizaos/plugin-elizacloud";
import { memoriesRepository } from "@/db/repositories/agents/memories";
import { charactersService } from "@/lib/services/characters/characters";
import type { ElizaCharacter } from "@/lib/types/eliza-character";
import { logger } from "@/lib/utils/logger";
import defaultAgent from "./agent";
import {
  AGENT_MODE_PLUGINS,
  AgentMode,
  getConditionalPlugins,
  hasAffiliateData,
  requiresAssistantMode,
  SETTINGS_PLUGIN_MAP,
} from "./agent-mode-types";
import { buildElevenLabsSettings, getElizaCloudApiUrl } from "./config";
import advancedMemoryPlugin from "./plugin-advanced-memory";
import { affiliatePlugin } from "./plugin-affiliate";
import { characterBuilderPlugin } from "./plugin-character-builder";
import { chatPlaygroundPlugin } from "./plugin-chat-playground";
import { cloudBootstrapPlugin } from "./plugin-cloud-bootstrap";
import mcpPlugin from "./plugin-mcp";
import { cloudN8nPlugin } from "./plugin-n8n";

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
      _webSearchPlugin = asPlugin(webSearchModule.webSearchPlugin);
    }

    logger.info("[AgentLoader] ⚡ Web search plugin preloaded");
  } catch (e) {
    logger.error("[AgentLoader] Plugin preload failed:", e);
  }
}

preloadPlugins();

export type ModeUpgradeReason = "settings_plugin" | "has_knowledge" | "none";

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
  // Note: no roomId filter — we want agent-level document count across all rooms
  const documentCount = await memoriesRepository.countByType(characterId, "documents");

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
      upgradeReason: "settings_plugin",
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
  _knowledgePlugin = asPlugin(knowledgePluginCore);
  return _knowledgePlugin;
}

async function getWebSearchPlugin(): Promise<Plugin> {
  if (_webSearchPlugin) return _webSearchPlugin;

  // Fallback to dynamic import if preload hasn't completed
  // Use local web-search plugin
  const { webSearchPlugin } = await import("./plugin-web-search/src");
  _webSearchPlugin = asPlugin(webSearchPlugin);
  return _webSearchPlugin;
}

/** Cast external plugin to local Plugin type for cross-version compatibility. */
function asPlugin<T extends { name: string; description: string }>(plugin: T): Plugin {
  return plugin as Plugin;
}

const AVAILABLE_PLUGINS: Record<string, Plugin> = {
  "@elizaos/plugin-elizacloud": asPlugin(elizaOSCloudPlugin),
  "@elizaos/plugin-elevenlabs": asPlugin(elevenLabsPlugin),
  "@eliza-cloud/plugin-advanced-memory": asPlugin(advancedMemoryPlugin),
  "@elizaos/plugin-mcp": asPlugin(mcpPlugin),
  "@elizaos/plugin-n8n-workflow": cloudN8nPlugin,
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
    const characterSettings = (elizaCharacter.settings ?? {}) as Record<string, unknown>;
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
    // Use default character's actual settings for plugin resolution
    const characterSettings: Record<string, unknown> = {
      ...(defaultAgent.character.settings ?? {}),
    };
    if (options?.webSearchEnabled) {
      characterSettings.webSearch = { enabled: true };
    }
    const modeResolution = await resolveEffectiveMode(
      agentMode,
      defaultAgent.character.id!,
      characterSettings,
      [],
    );
    const plugins = await this.resolvePlugins(modeResolution.mode, [], characterSettings);
    const character = this.buildCharacter({
      ...(defaultAgent.character as unknown as ElizaCharacter),
      settings: characterSettings as Record<
        string,
        string | number | boolean | Record<string, unknown>
      >,
    });

    return { character, plugins, modeResolution };
  }

  private buildCharacter(elizaCharacter: ElizaCharacter): Character {
    const characterId = elizaCharacter.id || "b850bc30-45f8-0041-a00a-83df46d8555d";
    const charSettings = (elizaCharacter.settings || {}) as Record<
      string,
      string | boolean | number | Record<string, unknown>
    >;

    const settings: Record<string, string | boolean | number | Record<string, unknown>> = {
      ...charSettings,
      POSTGRES_URL: process.env.DATABASE_URL!,
      DATABASE_URL: process.env.DATABASE_URL!,
      ELIZAOS_CLOUD_BASE_URL: getElizaCloudApiUrl(),
      // ElevenLabs settings (shared config)
      ...buildElevenLabsSettings(charSettings),
      ...(elizaCharacter.avatarUrl ? { avatarUrl: elizaCharacter.avatarUrl } : {}),
    };

    // parseCharacter() validates/normalizes character payloads from the DB shape.
    return parseCharacter({
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
    } as Record<string, unknown>);
  }

  private async resolvePlugins(
    agentMode: AgentMode,
    characterPlugins: string[],
    characterSettings: Record<string, unknown>,
    options?: { hasKnowledge?: boolean },
  ): Promise<Plugin[]> {
    const plugins: Plugin[] = [];
    const isAffiliate = hasAffiliateData(characterSettings);

    const conditionalPlugins = isAffiliate ? [] : getConditionalPlugins(characterSettings);

    const modePlugins = AGENT_MODE_PLUGINS[agentMode].map((pluginName) => {
      if (isAffiliate && pluginName === "@eliza-cloud/plugin-assistant") {
        return "@eliza-cloud/plugin-affiliate";
      }
      return pluginName;
    });

    const allPluginNames = [...modePlugins, ...characterPlugins, ...conditionalPlugins];

    // Only load knowledge plugin when documents actually exist
    // Upload capability is handled separately — no need to init the full plugin
    if (options?.hasKnowledge) {
      allPluginNames.push("knowledge");
      logger.info("[AgentLoader] Loading native knowledge plugin - documents found");
    }

    for (const pluginName of allPluginNames) {
      if (pluginName === "knowledge") {
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
