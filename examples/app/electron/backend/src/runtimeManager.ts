import {
  AgentRuntime,
  ChannelType,
  createCharacter,
  type Content,
  createMessageMemory,
  LLMMode,
  type Memory,
  type Plugin,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import {
  elizaClassicPlugin,
  getElizaGreeting,
} from "@elizaos/plugin-eliza-classic";
import localdbPlugin from "@elizaos/plugin-localdb";
import { v4 as uuidv4 } from "uuid";
import type { AppConfig, ChatMessage, ProviderMode } from "./types";
import { getEffectiveMode } from "./types";

type RuntimeBundle = {
  runtime: AgentRuntime;
  userId: UUID;
  roomId: UUID;
  worldId: UUID;
};

const CHAT_CHARACTER = createCharacter({
  name: "Eliza",
  bio: "A helpful assistant for simple back-and-forth chat.",
});

const worldId = stringToUuid("example-electron-world");
const userId = stringToUuid("example-electron-user");
const roomId = stringToUuid("example-electron-room");

let currentBundle: RuntimeBundle | null = null;
let currentMode: ProviderMode | null = null;
let initializing: Promise<RuntimeBundle> | null = null;

function applySettings(
  runtime: AgentRuntime,
  config: AppConfig,
  mode: ProviderMode,
  dataDir: string,
): void {
  runtime.setSetting("LLM_MODE", "DEFAULT");
  runtime.setSetting("CHECK_SHOULD_RESPOND", false);
  runtime.setSetting("LOCALDB_DATA_DIR", dataDir);

  if (mode === "openai") {
    runtime.setSetting("OPENAI_API_KEY", config.provider.openaiApiKey, true);
    runtime.setSetting("OPENAI_BASE_URL", config.provider.openaiBaseUrl);
    runtime.setSetting("OPENAI_SMALL_MODEL", config.provider.openaiSmallModel);
    runtime.setSetting("OPENAI_LARGE_MODEL", config.provider.openaiLargeModel);
  }

  if (mode === "anthropic") {
    runtime.setSetting("ANTHROPIC_API_KEY", config.provider.anthropicApiKey, true);
    runtime.setSetting("ANTHROPIC_SMALL_MODEL", config.provider.anthropicSmallModel);
    runtime.setSetting("ANTHROPIC_LARGE_MODEL", config.provider.anthropicLargeModel);
  }

  if (mode === "xai") {
    runtime.setSetting("OPENAI_API_KEY", config.provider.xaiApiKey, true);
    runtime.setSetting("OPENAI_BASE_URL", config.provider.xaiBaseUrl);
    runtime.setSetting("OPENAI_SMALL_MODEL", config.provider.xaiSmallModel);
    runtime.setSetting("OPENAI_LARGE_MODEL", config.provider.xaiLargeModel);
  }

  if (mode === "gemini") {
    runtime.setSetting("GOOGLE_GENERATIVE_AI_API_KEY", config.provider.googleGenaiApiKey, true);
    runtime.setSetting("GOOGLE_SMALL_MODEL", config.provider.googleSmallModel);
    runtime.setSetting("GOOGLE_LARGE_MODEL", config.provider.googleLargeModel);
  }

  if (mode === "groq") {
    runtime.setSetting("GROQ_API_KEY", config.provider.groqApiKey, true);
    runtime.setSetting("GROQ_BASE_URL", config.provider.groqBaseUrl);
    runtime.setSetting("GROQ_SMALL_MODEL", config.provider.groqSmallModel);
    runtime.setSetting("GROQ_LARGE_MODEL", config.provider.groqLargeModel);
  }

  if (mode === "openrouter") {
    runtime.setSetting("OPENROUTER_API_KEY", config.provider.openrouterApiKey, true);
    runtime.setSetting("OPENROUTER_BASE_URL", config.provider.openrouterBaseUrl);
    runtime.setSetting("OPENROUTER_SMALL_MODEL", config.provider.openrouterSmallModel);
    runtime.setSetting("OPENROUTER_LARGE_MODEL", config.provider.openrouterLargeModel);
  }

  if (mode === "ollama") {
    runtime.setSetting("OLLAMA_API_ENDPOINT", config.provider.ollamaApiEndpoint);
    runtime.setSetting("OLLAMA_SMALL_MODEL", config.provider.ollamaSmallModel);
    runtime.setSetting("OLLAMA_LARGE_MODEL", config.provider.ollamaLargeModel);
  }
}

async function buildPlugins(mode: ProviderMode): Promise<Plugin[]> {
  const base: Plugin[] = [localdbPlugin];
  switch (mode) {
    case "elizaClassic":
      return [...base, elizaClassicPlugin];
    case "openai":
      return [...base, (await import("@elizaos/plugin-openai")).default];
    case "anthropic":
      return [...base, (await import("@elizaos/plugin-anthropic")).default];
    case "xai":
      return [...base, (await import("@elizaos/plugin-openai")).default];
    case "gemini":
      return [...base, (await import("@elizaos/plugin-google-genai")).default];
    case "groq":
      return [...base, (await import("@elizaos/plugin-groq")).default];
    case "openrouter":
      return [...base, (await import("@elizaos/plugin-openrouter")).default];
    case "ollama":
      return [...base, (await import("@elizaos/plugin-ollama")).default];
    default:
      return [...base, elizaClassicPlugin];
  }
}

export async function getOrCreateRuntime(
  config: AppConfig,
  dataDir: string,
): Promise<RuntimeBundle> {
  const effectiveMode = getEffectiveMode(config);

  if (currentBundle && currentMode === effectiveMode) {
    applySettings(currentBundle.runtime, config, effectiveMode, dataDir);
    return currentBundle;
  }

  if (initializing) return initializing;

  initializing = (async () => {
    if (currentBundle) {
      await currentBundle.runtime.stop();
      currentBundle = null;
      currentMode = null;
    }

    const runtime = new AgentRuntime({
      character: CHAT_CHARACTER,
      plugins: await buildPlugins(effectiveMode),
      actionPlanning: false,
      llmMode: LLMMode.SMALL,
    });

    applySettings(runtime, config, effectiveMode, dataDir);
    await runtime.initialize();

    await runtime.ensureConnection({
      entityId: userId,
      roomId,
      worldId,
      userName: "User",
      source: "electron-main",
      channelId: "chat",
      type: ChannelType.DM,
    });

    currentBundle = { runtime, userId, roomId, worldId };
    currentMode = effectiveMode;
    return currentBundle;
  })();

  try {
    return await initializing;
  } finally {
    initializing = null;
  }
}

export function getGreetingText(config: AppConfig): string {
  const effectiveMode = getEffectiveMode(config);
  return effectiveMode === "elizaClassic"
    ? getElizaGreeting()
    : "Hello! What would you like to chat about?";
}

function memoryToChatMessage(m: Memory, bundle: RuntimeBundle): ChatMessage | null {
  const text = typeof m.content.text === "string" ? m.content.text : "";
  if (!text) return null;

  const ts =
    typeof m.createdAt === "number"
      ? m.createdAt
      : typeof m.createdAt === "string"
        ? Number(m.createdAt)
        : Date.now();

  const role: ChatMessage["role"] =
    m.entityId === bundle.userId ? "user" : "assistant";

  return {
    id: String(m.id),
    role,
    text,
    timestamp: Number.isFinite(ts) ? ts : Date.now(),
  };
}

export async function getHistory(config: AppConfig, dataDir: string): Promise<ChatMessage[]> {
  const bundle = await getOrCreateRuntime(config, dataDir);
  const memories = await bundle.runtime.getMemories({
    roomId: bundle.roomId,
    tableName: "messages",
    count: 100,
  });

  return memories
    .map((m) => memoryToChatMessage(m, bundle))
    .filter((m): m is ChatMessage => m !== null)
    .sort((a, b) => a.timestamp - b.timestamp);
}

export async function resetConversation(config: AppConfig, dataDir: string): Promise<void> {
  const bundle = await getOrCreateRuntime(config, dataDir);
  await bundle.runtime.deleteAllMemories(bundle.roomId, "messages");
}

export async function sendMessage(
  config: AppConfig,
  userText: string,
  dataDir: string,
): Promise<{ responseText: string; effectiveMode: ProviderMode }> {
  const bundle = await getOrCreateRuntime(config, dataDir);
  const effectiveMode = getEffectiveMode(config);

  if (!bundle.runtime.messageService) {
    throw new Error("Runtime message service not available");
  }

  const messageMemory = createMessageMemory({
    id: uuidv4() as UUID,
    entityId: bundle.userId,
    roomId: bundle.roomId,
    content: {
      text: userText,
      source: "electron-renderer",
      channelType: ChannelType.DM,
    },
  });

  let responseText = "";
  const result = await bundle.runtime.messageService.handleMessage(
    bundle.runtime,
    messageMemory,
    async (content: Content) => {
      if (typeof content.text === "string") responseText = content.text;
      // Persist assistant response in the same "messages" table for history.
      const assistantText = typeof content.text === "string" ? content.text.trim() : "";
      if (!assistantText) return [];
      return [
        createMessageMemory({
          id: uuidv4() as UUID,
          entityId: bundle.runtime.agentId,
          roomId: bundle.roomId,
          content: {
            ...content,
            text: assistantText,
            source: "electron-main",
            channelType: ChannelType.DM,
          },
        }),
      ];
    },
  );

  if (!responseText && typeof result.responseContent?.text === "string") {
    responseText = result.responseContent.text;
  }

  return { responseText, effectiveMode };
}

export async function __shutdownForTests(): Promise<void> {
  if (currentBundle) {
    await currentBundle.runtime.stop();
  }
  currentBundle = null;
  currentMode = null;
  initializing = null;
}

