import {
  type Action,
  type Character,
  documentsPluginCore,
  type Plugin,
  type Provider,
  parseCharacter,
} from "@elizaos/core";
import { memoriesRepository } from "@/db/repositories/agents/memories";
import { charactersService } from "@/lib/services/characters/characters";
import type { ElizaCharacter } from "@/lib/types/eliza-character";
import { logger } from "@/lib/utils/logger";
import defaultAgent from "./agent";
import {
  AGENT_MODE_PLUGINS,
  AgentMode,
  getConditionalPlugins,
  isValidAgentMode,
} from "./agent-mode-types";
import { cloudModelProviderPlugin } from "./cloud-model-provider";
import { buildElevenLabsSettings, getElizaCloudApiUrl } from "./config";
import mcpPlugin from "./plugin-mcp";

// Plugin cache - preloaded at module init to eliminate dynamic import latency
let _documentsPlugin: Plugin | null = null;
let _webSearchPlugin: Plugin | null = null;
let _elevenLabsPlugin: Plugin | null = null;
let _pluginsPreloading = false;

async function preloadPlugins(): Promise<void> {
  if (_pluginsPreloading) return;
  _pluginsPreloading = true;

  try {
    // Only preload web-search plugin (local version)
    // Documents plugin is loaded on-demand when documents exist
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

export type ModeUpgradeReason = "none";

export interface ModeResolution {
  mode: AgentMode;
  upgradeReason: ModeUpgradeReason;
  /** Document count from mode resolution - reuse to avoid duplicate DB query */
  documentCount?: number;
}

/** Determines effective agent mode. Backend mode has collapsed to chat. */
async function resolveEffectiveMode(
  requestedMode: AgentMode,
  characterId: string,
): Promise<ModeResolution> {
  // Query document count once - needed for multiple checks and plugin resolution
  // Note: no roomId filter — we want agent-level document count across all rooms
  const documentCount = await memoriesRepository.countByType(characterId, "documents");
  const mode = isValidAgentMode(requestedMode) ? requestedMode : AgentMode.CHAT;

  return { mode, upgradeReason: "none", documentCount };
}

async function getDocumentsPlugin(): Promise<Plugin> {
  if (_documentsPlugin) return _documentsPlugin;
  _documentsPlugin = asPlugin(documentsPluginCore);
  return _documentsPlugin;
}

async function getWebSearchPlugin(): Promise<Plugin> {
  if (_webSearchPlugin) return _webSearchPlugin;

  // Fallback to dynamic import if preload hasn't completed
  // Use local web-search plugin
  const { webSearchPlugin } = await import("./plugin-web-search/src");
  _webSearchPlugin = asPlugin(webSearchPlugin);
  return _webSearchPlugin;
}

async function getElevenLabsPlugin(): Promise<Plugin> {
  if (_elevenLabsPlugin) return _elevenLabsPlugin;

  const { elevenLabsPlugin } = await import("@elizaos/plugin-elevenlabs");
  _elevenLabsPlugin = asPlugin(elevenLabsPlugin);
  return _elevenLabsPlugin;
}

/** Cast external plugin to local Plugin type for cross-version compatibility. */
function asPlugin<T extends { name: string; description: string }>(plugin: T): Plugin {
  return plugin as Plugin;
}

const AVAILABLE_PLUGINS: Record<string, Plugin> = {
  "@elizaos/plugin-elizacloud": cloudModelProviderPlugin,
  elizaOSCloud: cloudModelProviderPlugin,
  "eliza-cloud-model-provider": cloudModelProviderPlugin,
  "@elizaos/plugin-mcp": asPlugin(mcpPlugin),
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

    const modeResolution = await resolveEffectiveMode(agentMode, characterId);

    const hasDocuments = (modeResolution.documentCount ?? 0) > 0;

    const plugins = await this.resolvePlugins(
      modeResolution.mode,
      characterPlugins,
      characterSettings,
      { hasDocuments },
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
    const modeResolution = await resolveEffectiveMode(agentMode, defaultAgent.character.id!);
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
    const documents = [...(elizaCharacter.documents ?? []), ...(elizaCharacter.knowledge ?? [])];
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
      documents,
      style: elizaCharacter.style,
      templates: elizaCharacter.templates,
    } as Record<string, unknown>);
  }

  private async resolvePlugins(
    agentMode: AgentMode,
    characterPlugins: string[],
    characterSettings: Record<string, unknown>,
    options?: { hasDocuments?: boolean },
  ): Promise<Plugin[]> {
    const plugins: Plugin[] = [cloudModelProviderPlugin];
    const conditionalPlugins = getConditionalPlugins(characterSettings);
    const modePlugins = isValidAgentMode(agentMode)
      ? AGENT_MODE_PLUGINS[agentMode]
      : AGENT_MODE_PLUGINS[AgentMode.CHAT];

    const allPluginNames = [...modePlugins, ...characterPlugins, ...conditionalPlugins];

    // Only load the documents plugin when documents actually exist.
    if (options?.hasDocuments) {
      allPluginNames.push("documents");
      logger.info("[AgentLoader] Loading native documents plugin - documents found");
    }

    for (const pluginName of allPluginNames) {
      if (pluginName === "documents") {
        const documentsPlugin = await getDocumentsPlugin();
        if (!plugins.includes(documentsPlugin)) plugins.push(documentsPlugin);
        continue;
      }

      if (pluginName === "@elizaos/plugin-web-search") {
        const webSearchPlugin = await getWebSearchPlugin();
        if (!plugins.includes(webSearchPlugin)) plugins.push(webSearchPlugin);
        continue;
      }

      if (pluginName === "@elizaos/plugin-elevenlabs") {
        const elevenLabsPlugin = await getElevenLabsPlugin();
        if (!plugins.includes(elevenLabsPlugin)) plugins.push(elevenLabsPlugin);
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
