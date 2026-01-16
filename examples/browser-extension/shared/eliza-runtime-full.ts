/**
 * Full Eliza Runtime for Browser Extension
 * 
 * Based on examples/avatar/src/runtime/runtimeManager.ts
 */

import {
  AgentRuntime,
  ChannelType,
  createCharacter,
  type Content,
  createMessageMemory,
  LLMMode,
  type Provider,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import anthropicPlugin from "@elizaos/plugin-anthropic";
import { elizaClassicPlugin, getElizaGreeting } from "@elizaos/plugin-eliza-classic";
import googleGenAIPlugin from "@elizaos/plugin-google-genai";
import groqPlugin from "@elizaos/plugin-groq";
import localdbPlugin from "@elizaos/plugin-localdb";
import openaiPlugin from "@elizaos/plugin-openai";
import { v4 as uuidv4 } from "uuid";
import type { ExtensionConfig, PageContent, ProviderMode } from "./types";

// ============================================
// Types
// ============================================

export type SendMessageResult = { responseText: string };
export type SendMessageCallbacks = { onAssistantChunk?: (chunk: string) => void };

type RuntimeBundle = {
  runtime: AgentRuntime;
  userId: UUID;
  roomId: UUID;
  worldId: UUID;
};

// ============================================
// Character Definition
// ============================================

const BROWSER_ASSISTANT_CHARACTER = createCharacter({
  name: "Browser Assistant",
  system: `You are a helpful browser assistant that can discuss the content of webpages with users.
When the user asks about "this page", "this article", "this website", or similar, refer to the PAGE_CONTENT context.
Be concise and helpful. Focus on answering questions about the page content when relevant.`,
  bio: "An AI assistant built on ElizaOS that helps users understand and interact with web content.",
});

// ============================================
// Storage Keys
// ============================================

const STORAGE_KEYS = { 
  userId: "elizaos-extension:userId",
  roomId: "elizaos-extension:roomId",
} as const;

// ============================================
// Page Content Provider
// ============================================

let cachedPageContent: PageContent | null = null;
let cachedSelectedText: string | null = null;
let cachedScreenshot: string | null = null;
let lastScreenshotHash: string | null = null;

export function updatePageContent(content: PageContent | null): void {
  console.log("[ElizaOS Runtime] updatePageContent called:", content ? {
    title: content.title,
    url: content.url,
    contentLength: content.content?.length,
    hasSelectedText: !!content.selectedText,
    hasVisibleText: !!content.visibleText,
  } : null);
  
  cachedPageContent = content;
  if (content?.selectedText) {
    cachedSelectedText = content.selectedText;
  }
}

export function updateSelectedText(text: string | null): void {
  cachedSelectedText = text;
}

export function updateScreenshot(dataUrl: string | null): void {
  if (!dataUrl) {
    cachedScreenshot = null;
    return;
  }
  
  // Simple hash to detect duplicate screenshots
  const hash = dataUrl.substring(dataUrl.length - 100);
  if (hash === lastScreenshotHash) {
    // Same screenshot, don't update
    return;
  }
  
  lastScreenshotHash = hash;
  cachedScreenshot = dataUrl;
}

export function getScreenshot(): string | null {
  return cachedScreenshot;
}

export function clearScreenshot(): void {
  cachedScreenshot = null;
  lastScreenshotHash = null;
}

const pageContentProvider: Provider = {
  name: "PAGE_CONTENT",
  description: "Current webpage content that the user is viewing",
  get: async () => {
    if (!cachedPageContent) {
      return { text: "No page content available. The user may be on a browser page that cannot be read." };
    }
    
    let context = `## Current Webpage
**Title:** ${cachedPageContent.title}
**URL:** ${cachedPageContent.url}
`;

    // Add selected text if available
    if (cachedSelectedText) {
      context += `
### User's Selected Text:
"${cachedSelectedText}"
`;
    }

    // Add visible text indicator if available
    if (cachedPageContent.visibleText) {
      context += `
### Currently Visible on Screen:
${cachedPageContent.visibleText}
`;
    }

    context += `
### Full Page Content:
${cachedPageContent.content}
`;

    return { text: context };
  },
};

// ============================================
// Helper Functions
// ============================================

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

export function resolveEffectiveMode(config: ExtensionConfig): ProviderMode {
  switch (config.mode) {
    case "openai":
      return (config.provider.openaiApiKey ?? "").trim() ? "openai" : "elizaClassic";
    case "anthropic":
      return (config.provider.anthropicApiKey ?? "").trim() ? "anthropic" : "elizaClassic";
    case "xai":
      return (config.provider.xaiApiKey ?? "").trim() ? "xai" : "elizaClassic";
    case "gemini":
      return (config.provider.googleGenaiApiKey ?? "").trim() ? "gemini" : "elizaClassic";
    case "groq":
      return (config.provider.groqApiKey ?? "").trim() ? "groq" : "elizaClassic";
    case "elizaClassic":
      return "elizaClassic";
    default:
      return "elizaClassic";
  }
}

function applySettings(runtime: AgentRuntime, config: ExtensionConfig, effectiveMode: ProviderMode): void {
  runtime.setSetting("LLM_MODE", "DEFAULT");
  runtime.setSetting("CHECK_SHOULD_RESPOND", false);

  if (effectiveMode === "openai") {
    runtime.setSetting("OPENAI_ALLOW_BROWSER_API_KEY", "true");
    runtime.setSetting("OPENAI_API_KEY", config.provider.openaiApiKey ?? "", true);
    runtime.setSetting("OPENAI_BASE_URL", config.provider.openaiBaseUrl ?? "");
    runtime.setSetting("OPENAI_SMALL_MODEL", config.provider.openaiSmallModel ?? "gpt-5-mini");
    runtime.setSetting("OPENAI_LARGE_MODEL", config.provider.openaiLargeModel ?? "gpt-5");
  }

  if (effectiveMode === "anthropic") {
    runtime.setSetting("ANTHROPIC_API_KEY", config.provider.anthropicApiKey ?? "", true);
    runtime.setSetting("ANTHROPIC_SMALL_MODEL", config.provider.anthropicSmallModel ?? "claude-3-haiku-20240307");
    runtime.setSetting("ANTHROPIC_LARGE_MODEL", config.provider.anthropicLargeModel ?? "claude-3-5-sonnet-20241022");
  }

  if (effectiveMode === "xai") {
    runtime.setSetting("OPENAI_ALLOW_BROWSER_API_KEY", "true");
    runtime.setSetting("OPENAI_API_KEY", config.provider.xaiApiKey ?? "", true);
    runtime.setSetting("OPENAI_BASE_URL", config.provider.xaiBaseUrl ?? "https://api.x.ai/v1");
    runtime.setSetting("OPENAI_SMALL_MODEL", config.provider.xaiSmallModel ?? "grok-2-latest");
    runtime.setSetting("OPENAI_LARGE_MODEL", config.provider.xaiLargeModel ?? "grok-2-latest");
  }

  if (effectiveMode === "gemini") {
    runtime.setSetting("GOOGLE_GENERATIVE_AI_API_KEY", config.provider.googleGenaiApiKey ?? "", true);
    runtime.setSetting("GOOGLE_SMALL_MODEL", config.provider.googleSmallModel ?? "gemini-1.5-flash");
    runtime.setSetting("GOOGLE_LARGE_MODEL", config.provider.googleLargeModel ?? "gemini-1.5-pro");
  }

  if (effectiveMode === "groq") {
    runtime.setSetting("GROQ_API_KEY", config.provider.groqApiKey ?? "", true);
    runtime.setSetting("GROQ_BASE_URL", config.provider.groqBaseUrl ?? "");
    runtime.setSetting("GROQ_SMALL_MODEL", config.provider.groqSmallModel ?? "llama-3.1-8b-instant");
    runtime.setSetting("GROQ_LARGE_MODEL", config.provider.groqLargeModel ?? "llama-3.3-70b-versatile");
  }
}

function buildPlugins(effectiveMode: ProviderMode) {
  const base = [localdbPlugin];
  if (effectiveMode === "elizaClassic") return [...base, elizaClassicPlugin];
  if (effectiveMode === "openai") return [...base, openaiPlugin];
  if (effectiveMode === "anthropic") return [...base, anthropicPlugin];
  if (effectiveMode === "xai") return [...base, openaiPlugin]; // xAI uses OpenAI-compatible API
  if (effectiveMode === "gemini") return [...base, googleGenAIPlugin];
  if (effectiveMode === "groq") return [...base, groqPlugin];
  return [...base, elizaClassicPlugin];
}

// ============================================
// Runtime Management
// ============================================

let currentBundle: RuntimeBundle | null = null;
let currentMode: ProviderMode | null = null;
let initializing: Promise<RuntimeBundle> | null = null;

export async function getOrCreateRuntime(config: ExtensionConfig): Promise<RuntimeBundle> {
  const effectiveMode = resolveEffectiveMode(config);

  if (currentBundle && currentMode === effectiveMode) {
    applySettings(currentBundle.runtime, config, effectiveMode);
    return currentBundle;
  }

  if (initializing) return initializing;

  initializing = (async () => {
    if (currentBundle) {
      await currentBundle.runtime.stop();
      currentBundle = null;
      currentMode = null;
    }

    const userId = getOrCreateUserId();
    const roomId = getOrCreateRoomId();
    const worldId = stringToUuid("elizaos-browser-extension-world");

    const plugins = buildPlugins(effectiveMode);

    const runtime = new AgentRuntime({
      character: BROWSER_ASSISTANT_CHARACTER,
      plugins,
      actionPlanning: false,
      llmMode: LLMMode.SMALL,
    });

    // Register the page content provider
    runtime.registerProvider(pageContentProvider);

    applySettings(runtime, config, effectiveMode);
    await runtime.initialize();

    await runtime.ensureConnection({
      entityId: userId,
      roomId,
      worldId,
      userName: "User",
      source: "browser-extension",
      channelId: "browser-extension",
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

export function getGreetingText(effectiveMode: ProviderMode): string {
  if (effectiveMode === "elizaClassic") {
    return getElizaGreeting();
  }
  return "Hello! I can help you understand and discuss the content of this webpage. What would you like to know?";
}

/**
 * Build message text with page context injected.
 * Since ElizaOS message service doesn't call custom providers by default,
 * we inject the context directly into the message.
 */
function buildMessageWithContext(userText: string): string {
  console.log("[ElizaOS Runtime] Building message with context...");
  console.log("[ElizaOS Runtime] cachedPageContent:", cachedPageContent ? {
    title: cachedPageContent.title,
    url: cachedPageContent.url,
    contentLength: cachedPageContent.content?.length,
    hasVisibleText: !!cachedPageContent.visibleText,
  } : null);
  console.log("[ElizaOS Runtime] cachedSelectedText:", cachedSelectedText?.substring(0, 100));
  
  // Build context prefix
  let contextPrefix = "";
  
  if (cachedPageContent && cachedPageContent.content) {
    contextPrefix += `[PAGE CONTEXT]\n`;
    contextPrefix += `Title: ${cachedPageContent.title}\n`;
    contextPrefix += `URL: ${cachedPageContent.url}\n`;
    
    if (cachedSelectedText) {
      contextPrefix += `\nUser's Selected Text: "${cachedSelectedText}"\n`;
    }
    
    if (cachedPageContent.visibleText) {
      contextPrefix += `\nCurrently Visible on Screen:\n${cachedPageContent.visibleText.substring(0, 2000)}\n`;
    }
    
    // Include main content (truncated to fit context)
    const maxContentLength = 50000; // ~12k tokens
    const content = cachedPageContent.content.substring(0, maxContentLength);
    contextPrefix += `\nPage Content:\n${content}\n`;
    
    if (cachedPageContent.content.length > maxContentLength) {
      contextPrefix += `[Content truncated...]\n`;
    }
    
    contextPrefix += `[END PAGE CONTEXT]\n\n`;
  } else {
    console.warn("[ElizaOS Runtime] No page content available!");
  }
  
  const result = contextPrefix + `User message: ${userText}`;
  console.log("[ElizaOS Runtime] Final message length:", result.length, "Context prefix length:", contextPrefix.length);
  
  return result;
}

export async function sendMessage(
  config: ExtensionConfig,
  userText: string,
  callbacks: SendMessageCallbacks = {},
): Promise<SendMessageResult> {
  const bundle = await getOrCreateRuntime(config);

  if (!bundle.runtime.messageService) {
    throw new Error("Runtime message service not available");
  }

  // Build message with page context injected
  const fullText = buildMessageWithContext(userText);

  const messageMemory = createMessageMemory({
    id: uuidv4() as UUID,
    entityId: bundle.userId,
    roomId: bundle.roomId,
    content: { text: fullText, source: "browser-extension", channelType: ChannelType.DM },
  });

  let responseText = "";
  const streaming = typeof callbacks.onAssistantChunk === "function";

  const result = await bundle.runtime.messageService.handleMessage(
    bundle.runtime,
    messageMemory,
    async (content: Content) => {
      if (!streaming && typeof content.text === "string") responseText = content.text;
      return [];
    },
    streaming
      ? {
          onStreamChunk: async (chunk: string) => {
            responseText += chunk;
            callbacks.onAssistantChunk?.(chunk);
          },
        }
      : undefined,
  );

  if (!responseText && typeof result.responseContent?.text === "string") {
    responseText = result.responseContent.text;
  }

  return { responseText };
}
