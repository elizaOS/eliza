import {
  AgentRuntime,
  ChannelType,
  createCharacter,
  type Character,
  type Content,
  createMessageMemory,
  LLMMode,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import anthropicPlugin from "@elizaos/plugin-anthropic";
import { elizaClassicPlugin, getElizaGreeting } from "@elizaos/plugin-eliza-classic";
import elevenLabsPlugin from "@elizaos/plugin-elevenlabs";
import googleGenAIPlugin from "@elizaos/plugin-google-genai";
import groqPlugin from "@elizaos/plugin-groq";
import localdbPlugin from "@elizaos/plugin-localdb";
import openaiPlugin from "@elizaos/plugin-openai";
import { simpleVoicePlugin } from "@elizaos/plugin-simple-voice";
import { v4 as uuidv4 } from "uuid";
import type { DemoConfig, DemoMode } from "./types";

export type SendMessageResult = { responseText: string };
export type SendMessageCallbacks = { onAssistantChunk?: (chunk: string) => void };

type RuntimeBundle = {
  runtime: AgentRuntime;
  userId: UUID;
  roomId: UUID;
  worldId: UUID;
};

const DEMO_CHARACTER: Character = createCharacter({
  name: "Cool Robot",
  system: "Cool Robot is very concise, to the point and brief robot who keeps responses very brief. No emojis or punctuation. Cool Robot responds very concisely, and never more than a sentence. He doens't use any punction, always all lower case",
  bio: "A nice and friendly robot built on the elizaOS agent framework.",
});

const STORAGE_KEYS = { userId: "eliza-vrm-demo:userId" } as const;

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
    const existing = localStorage.getItem("eliza-vrm-demo:roomId");
    if (existing) return existing as UUID;
    const created = uuidv4() as UUID;
    localStorage.setItem("eliza-vrm-demo:roomId", created);
    return created;
  } catch {
    return uuidv4() as UUID;
  }
}

export async function resetConversation(): Promise<void> {
  // Rotate the room id so localdb history is effectively reset.
  try {
    localStorage.setItem("eliza-vrm-demo:roomId", uuidv4());
  } catch {
    // ignore
  }

  if (currentBundle) {
    await currentBundle.runtime.stop();
    currentBundle = null;
    currentMode = null;
  }
}

function resolveEffectiveMode(config: DemoConfig): DemoMode {
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

function applySettings(runtime: AgentRuntime, config: DemoConfig, effectiveMode: DemoMode): void {
  runtime.setSetting("LLM_MODE", "DEFAULT");
  runtime.setSetting("CHECK_SHOULD_RESPOND", false);

  // ElevenLabs TTS (used by the VRM demo when enabled)
  runtime.setSetting("ELEVENLABS_API_KEY", config.provider.elevenlabsApiKey ?? "", true);
  runtime.setSetting("ELEVENLABS_VOICE_ID", "ZEcx3Wdpj4EvM8PltzHY");

  if (effectiveMode === "openai") {
    runtime.setSetting("OPENAI_ALLOW_BROWSER_API_KEY", "true");
    runtime.setSetting("OPENAI_API_KEY", config.provider.openaiApiKey ?? "", true);
    runtime.setSetting("OPENAI_BASE_URL", config.provider.openaiBaseUrl ?? "");
    runtime.setSetting("OPENAI_SMALL_MODEL", config.provider.openaiSmallModel ?? "");
    runtime.setSetting("OPENAI_LARGE_MODEL", config.provider.openaiLargeModel ?? "");
    const browserUrl = (config.provider.openaiBrowserBaseUrl ?? "").trim();
    if (browserUrl) {
      runtime.setSetting("OPENAI_BROWSER_BASE_URL", browserUrl);
      runtime.setSetting("OPENAI_BROWSER_EMBEDDING_URL", browserUrl);
    }
  }

  if (effectiveMode === "anthropic") {
    runtime.setSetting("ANTHROPIC_API_KEY", config.provider.anthropicApiKey ?? "", true);
    runtime.setSetting("ANTHROPIC_SMALL_MODEL", config.provider.anthropicSmallModel ?? "");
    runtime.setSetting("ANTHROPIC_LARGE_MODEL", config.provider.anthropicLargeModel ?? "");
    const browserUrl = (config.provider.anthropicBrowserBaseUrl ?? "").trim();
    if (browserUrl) {
      runtime.setSetting("ANTHROPIC_BROWSER_BASE_URL", browserUrl);
    }
  }

  if (effectiveMode === "xai") {
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

function buildPlugins(effectiveMode: DemoMode) {
  const base = [localdbPlugin, simpleVoicePlugin, elevenLabsPlugin];
  if (effectiveMode === "elizaClassic") return [...base, elizaClassicPlugin];
  if (effectiveMode === "openai") return [...base, openaiPlugin];
  if (effectiveMode === "anthropic") return [...base, anthropicPlugin];
  if (effectiveMode === "xai") return [...base, openaiPlugin];
  if (effectiveMode === "gemini") return [...base, googleGenAIPlugin];
  if (effectiveMode === "groq") return [...base, groqPlugin];
  return [...base, elizaClassicPlugin];
}

let currentBundle: RuntimeBundle | null = null;
let currentMode: DemoMode | null = null;
let initializing: Promise<RuntimeBundle> | null = null;

export async function getOrCreateRuntime(config: DemoConfig): Promise<RuntimeBundle> {
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
    const worldId = stringToUuid("eliza-vrm-demo-world");

    const runtime = new AgentRuntime({
      character: DEMO_CHARACTER,
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
      source: "vrm-web",
      channelId: "vrm-demo",
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

export function getGreetingText(effectiveMode: DemoMode): string {
  return effectiveMode === "elizaClassic" ? getElizaGreeting() : "Hello. I’m ready. What would you like to talk about?";
}

export function getEffectiveMode(config: DemoConfig): DemoMode {
  return resolveEffectiveMode(config);
}

export async function sendUserMessage(
  config: DemoConfig,
  userText: string,
  callbacks: SendMessageCallbacks = {},
): Promise<SendMessageResult> {
  const bundle = await getOrCreateRuntime(config);

  if (!bundle.runtime.messageService) {
    throw new Error("Runtime message service not available");
  }

  const messageMemory = createMessageMemory({
    id: uuidv4() as UUID,
    entityId: bundle.userId,
    roomId: bundle.roomId,
    content: { text: userText, source: "vrm-web", channelType: ChannelType.DM },
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