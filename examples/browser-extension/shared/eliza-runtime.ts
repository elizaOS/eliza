/**
 * Browser Extension Eliza Runtime Manager
 *
 * Manages the AgentRuntime for the browser extension with support for
 * multiple providers (OpenAI, Anthropic, Groq, Gemini, xAI, ELIZA classic).
 *
 * Based on the pattern from examples/vrm/src/runtime/runtimeManager.ts
 */

import {
  AgentRuntime,
  ChannelType,
  createCharacter,
  type Content,
  createMessageMemory,
  LLMMode,
  type Plugin,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import anthropicPlugin from "@elizaos/plugin-anthropic";
import {
  elizaClassicPlugin,
  getElizaGreeting,
} from "@elizaos/plugin-eliza-classic";
import googleGenAIPlugin from "@elizaos/plugin-google-genai";
import groqPlugin from "@elizaos/plugin-groq";
import localdbPlugin from "@elizaos/plugin-localdb";
import openaiPlugin from "@elizaos/plugin-openai";
import { v4 as uuidv4 } from "uuid";
import {
  pageContentProvider,
  setPageContent,
} from "./providers/pageContentProvider";
import {
  type ExtensionConfig,
  getEffectiveMode,
  type PageContent,
  type ProviderMode,
} from "./types";

// Runtime bundle type
type RuntimeBundle = {
  runtime: AgentRuntime;
  userId: UUID;
  roomId: UUID;
  worldId: UUID;
};

// Character for the webpage assistant
const WEBPAGE_ASSISTANT_CHARACTER = createCharacter({
  name: "Webpage Assistant",
  system: `You are a helpful assistant that can answer questions about the webpage the user is currently viewing.
You have access to the page content and can help the user understand, summarize, or find information on the page.
Be concise and helpful. If you don't know the answer based on the page content, say so.
When asked about the page, refer to specific content from it.`,
  bio: "An AI assistant built on elizaOS that helps you chat with and understand webpages.",
});

// Storage keys
const STORAGE_KEYS = {
  userId: "eliza-browser-ext:userId",
  roomId: "eliza-browser-ext:roomId",
} as const;

// Get or create persistent user ID
function getOrCreateUserId(): UUID {
  try {
    const existing = localStorage.getItem(STORAGE_KEYS.userId);
    if (existing) return existing as UUID;
    const created = uuidv4() as UUID;
    localStorage.setItem(STORAGE_KEYS.userId, created);
    return created;
  } catch {
    return uuidv4() as UUID;
  }
}

// Get or create persistent room ID (for conversation history)
function getOrCreateRoomId(): UUID {
  try {
    const existing = localStorage.getItem(STORAGE_KEYS.roomId);
    if (existing) return existing as UUID;
    const created = uuidv4() as UUID;
    localStorage.setItem(STORAGE_KEYS.roomId, created);
    return created;
  } catch {
    return uuidv4() as UUID;
  }
}

// Apply provider settings to the runtime
function applySettings(
  runtime: AgentRuntime,
  config: ExtensionConfig,
  effectiveMode: ProviderMode
): void {
  runtime.setSetting("LLM_MODE", "DEFAULT");
  runtime.setSetting("CHECK_SHOULD_RESPOND", false);

  if (effectiveMode === "openai") {
    runtime.setSetting("OPENAI_ALLOW_BROWSER_API_KEY", "true");
    runtime.setSetting("OPENAI_API_KEY", config.provider.openaiApiKey ?? "", true);
    runtime.setSetting("OPENAI_BASE_URL", config.provider.openaiBaseUrl ?? "");
    runtime.setSetting("OPENAI_SMALL_MODEL", config.provider.openaiSmallModel ?? "");
    runtime.setSetting("OPENAI_LARGE_MODEL", config.provider.openaiLargeModel ?? "");
  }

  if (effectiveMode === "anthropic") {
    runtime.setSetting("ANTHROPIC_API_KEY", config.provider.anthropicApiKey ?? "", true);
    runtime.setSetting("ANTHROPIC_SMALL_MODEL", config.provider.anthropicSmallModel ?? "");
    runtime.setSetting("ANTHROPIC_LARGE_MODEL", config.provider.anthropicLargeModel ?? "");
  }

  if (effectiveMode === "xai") {
    // xAI uses OpenAI-compatible API
    runtime.setSetting("OPENAI_ALLOW_BROWSER_API_KEY", "true");
    runtime.setSetting("OPENAI_API_KEY", config.provider.xaiApiKey ?? "", true);
    runtime.setSetting("OPENAI_BASE_URL", config.provider.xaiBaseUrl ?? "");
    runtime.setSetting("OPENAI_SMALL_MODEL", config.provider.xaiSmallModel ?? "");
    runtime.setSetting("OPENAI_LARGE_MODEL", config.provider.xaiLargeModel ?? "");
  }

  if (effectiveMode === "gemini") {
    runtime.setSetting("GOOGLE_GENERATIVE_AI_API_KEY", config.provider.googleGenaiApiKey ?? "", true);
    runtime.setSetting("GOOGLE_SMALL_MODEL", config.provider.googleSmallModel ?? "");
    runtime.setSetting("GOOGLE_LARGE_MODEL", config.provider.googleLargeModel ?? "");
  }

  if (effectiveMode === "groq") {
    runtime.setSetting("GROQ_API_KEY", config.provider.groqApiKey ?? "", true);
    runtime.setSetting("GROQ_BASE_URL", config.provider.groqBaseUrl ?? "");
    runtime.setSetting("GROQ_SMALL_MODEL", config.provider.groqSmallModel ?? "");
    runtime.setSetting("GROQ_LARGE_MODEL", config.provider.groqLargeModel ?? "");
  }
}

// Build plugin list based on effective mode
function buildPlugins(effectiveMode: ProviderMode): Plugin[] {
  // Base plugins - localdb for browser storage
  const base: Plugin[] = [localdbPlugin];

  // Create a plugin that registers our page content provider
  const pageContentPlugin: Plugin = {
    name: "page-content-plugin",
    description: "Provides page content context to the agent",
    providers: [pageContentProvider],
  };

  base.push(pageContentPlugin);

  // Add the appropriate model plugin based on mode
  switch (effectiveMode) {
    case "elizaClassic":
      return [...base, elizaClassicPlugin];
    case "openai":
      return [...base, openaiPlugin];
    case "anthropic":
      return [...base, anthropicPlugin];
    case "xai":
      // xAI uses OpenAI-compatible API
      return [...base, openaiPlugin];
    case "gemini":
      return [...base, googleGenAIPlugin];
    case "groq":
      return [...base, groqPlugin];
    default:
      return [...base, elizaClassicPlugin];
  }
}

// Singleton runtime management
let currentBundle: RuntimeBundle | null = null;
let currentMode: ProviderMode | null = null;
let initializing: Promise<RuntimeBundle> | null = null;

/**
 * Reset conversation (clears room ID to start fresh)
 */
export async function resetConversation(): Promise<void> {
  try {
    localStorage.setItem(STORAGE_KEYS.roomId, uuidv4());
  } catch {
    // ignore
  }

  if (currentBundle) {
    await currentBundle.runtime.stop();
    currentBundle = null;
    currentMode = null;
  }
}

/**
 * Get or create the AgentRuntime
 */
export async function getOrCreateRuntime(
  config: ExtensionConfig
): Promise<RuntimeBundle> {
  const effectiveMode = getEffectiveMode(config);

  // Return existing bundle if mode hasn't changed
  if (currentBundle && currentMode === effectiveMode) {
    applySettings(currentBundle.runtime, config, effectiveMode);
    return currentBundle;
  }

  // Wait for existing initialization
  if (initializing) return initializing;

  initializing = (async () => {
    // Stop existing runtime if mode changed
    if (currentBundle) {
      await currentBundle.runtime.stop();
      currentBundle = null;
      currentMode = null;
    }

    const userId = getOrCreateUserId();
    const roomId = getOrCreateRoomId();
    const worldId = stringToUuid("eliza-browser-extension-world");

    const runtime = new AgentRuntime({
      character: WEBPAGE_ASSISTANT_CHARACTER,
      plugins: buildPlugins(effectiveMode),
      actionPlanning: false,
      llmMode: LLMMode.SMALL,
    });

    applySettings(runtime, config, effectiveMode);
    await runtime.initialize();

    await runtime.ensureConnection({
      entityId: userId,
      roomId,
      worldId,
      userName: "User",
      source: "browser-extension",
      channelId: "webpage-chat",
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

/**
 * Get the greeting text based on mode
 */
export function getGreetingText(effectiveMode: ProviderMode): string {
  if (effectiveMode === "elizaClassic") {
    return getElizaGreeting();
  }
  return "Hello! I can help you understand this webpage. What would you like to know?";
}

/**
 * Update the page content in the runtime
 */
export async function updatePageContent(
  config: ExtensionConfig,
  pageContent: PageContent | null
): Promise<void> {
  const bundle = await getOrCreateRuntime(config);
  await setPageContent(bundle.runtime, pageContent);
}

/**
 * Send a message to the agent and get a response
 */
export async function sendMessage(
  config: ExtensionConfig,
  userText: string,
  callbacks: {
    onChunk?: (chunk: string) => void;
  } = {}
): Promise<{ responseText: string }> {
  const bundle = await getOrCreateRuntime(config);

  if (!bundle.runtime.messageService) {
    throw new Error("Runtime message service not available");
  }

  const messageMemory = createMessageMemory({
    id: uuidv4() as UUID,
    entityId: bundle.userId,
    roomId: bundle.roomId,
    content: {
      text: userText,
      source: "browser-extension",
      channelType: ChannelType.DM,
    },
  });

  let responseText = "";
  const streaming = typeof callbacks.onChunk === "function";

  const result = await bundle.runtime.messageService.handleMessage(
    bundle.runtime,
    messageMemory,
    async (content: Content) => {
      if (!streaming && typeof content.text === "string") {
        responseText = content.text;
      }
      return [];
    },
    streaming
      ? {
          onStreamChunk: async (chunk: string) => {
            responseText += chunk;
            callbacks.onChunk?.(chunk);
          },
        }
      : undefined
  );

  if (!responseText && typeof result.responseContent?.text === "string") {
    responseText = result.responseContent.text;
  }

  return { responseText };
}

/**
 * Get the current runtime bundle (if initialized)
 */
export function getCurrentRuntime(): RuntimeBundle | null {
  return currentBundle;
}
