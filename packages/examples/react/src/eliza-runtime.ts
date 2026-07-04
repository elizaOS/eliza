/**
 * elizaOS Runtime Service for React
 *
 * This module provides an AgentRuntime instance configured for browser use
 * with a PGlite database (in-memory WASM Postgres) and a real LLM inference
 * provider selected from whichever API key env var is set.
 *
 * Provider priority: OpenAI -> OpenRouter -> Anthropic -> Eliza Cloud.
 *
 * PGlite runs Postgres entirely in the browser via WASM - no DB server needed!
 */

import {
  AgentRuntime,
  ChannelType,
  type Character,
  type Content,
  createCharacter,
  createMessageMemory,
  type Memory,
  type Plugin,
  stringToUuid,
  type UUID,
} from "@elizaos/core";
import { getPgliteSingletonCache } from "@elizaos/plugin-sql";
import { v4 as uuidv4 } from "uuid";
import { createBrowserPGlite } from "./pglite-browser";

const { default: sqlPlugin } = await import("@elizaos/plugin-sql");

// ============================================================================
// Types
// ============================================================================

export interface ElizaRuntimeState {
  isInitialized: boolean;
  isInitializing: boolean;
  error: Error | null;
}

export interface ChatMessage {
  id: string;
  text: string;
  isUser: boolean;
  timestamp: Date;
}

// ============================================================================
// Inference provider selection
// ============================================================================

export type InferenceProviderName =
  | "openai"
  | "openrouter"
  | "anthropic"
  | "elizacloud";

interface SelectedProvider {
  name: InferenceProviderName;
  plugin: Plugin;
  /** Character secret key the provider plugin reads at init. */
  secretKey: string;
  secretValue: string;
}

/**
 * Pick an inference provider based on which API key env var is set.
 * Priority: OpenAI -> OpenRouter -> Anthropic -> Eliza Cloud.
 *
 * The chosen provider plugin is imported lazily so only its code lands in the
 * loaded chunk. Throws when no key is configured - there is no offline
 * fallback.
 */
async function selectInferenceProvider(): Promise<SelectedProvider> {
  const env = process.env;

  if (env.OPENAI_API_KEY) {
    const { openaiPlugin } = await import("@elizaos/plugin-openai");
    return {
      name: "openai",
      plugin: openaiPlugin,
      secretKey: "OPENAI_API_KEY",
      secretValue: env.OPENAI_API_KEY,
    };
  }

  if (env.OPENROUTER_API_KEY) {
    const { openrouterPlugin } = await import("@elizaos/plugin-openrouter");
    return {
      name: "openrouter",
      plugin: openrouterPlugin,
      secretKey: "OPENROUTER_API_KEY",
      secretValue: env.OPENROUTER_API_KEY,
    };
  }

  if (env.ANTHROPIC_API_KEY) {
    // plugin-anthropic exposes the plugin as both the named `anthropicPlugin`
    // and the default export; we use the default to match the other repo
    // examples (browser-extension, rest-api).
    const { default: anthropicPlugin } = await import(
      "@elizaos/plugin-anthropic"
    );
    return {
      name: "anthropic",
      plugin: anthropicPlugin,
      secretKey: "ANTHROPIC_API_KEY",
      secretValue: env.ANTHROPIC_API_KEY,
    };
  }

  if (env.ELIZA_API_KEY) {
    const { elizaOSCloudPlugin } = await import("@elizaos/plugin-elizacloud");
    return {
      name: "elizacloud",
      plugin: elizaOSCloudPlugin,
      // The cloud plugin reads ELIZAOS_CLOUD_API_KEY at init.
      secretKey: "ELIZAOS_CLOUD_API_KEY",
      secretValue: env.ELIZA_API_KEY,
    };
  }

  throw new Error(
    "No inference provider configured. Set one of OPENAI_API_KEY, OPENROUTER_API_KEY, ANTHROPIC_API_KEY, or ELIZA_API_KEY.",
  );
}

// ============================================================================
// Character Configuration
// ============================================================================

const elizaCharacter: Character = createCharacter({
  name: "ELIZA",
  bio: "A Rogerian psychotherapist simulation based on Joseph Weizenbaum's 1966 program. I use pattern matching to engage in therapeutic conversations.",
  system: `You are ELIZA, a Rogerian psychotherapist simulation. Your role is to:
- Listen empathetically to the user
- Reflect their statements back to them
- Ask open-ended questions to encourage self-exploration
- Never give direct advice or diagnoses
  - Focus on feelings and emotions`,
});

// ============================================================================
// Pre-initialize PGlite with browser-friendly asset loading
// ============================================================================

/**
 * Pre-initialize PGlite before the SQL plugin runs.
 * This ensures PGlite's WASM and data files are loaded from the correct location.
 *
 * Seeds the browser-configured PGlite into plugin-sql's global singleton cache
 * through its public {@link getPgliteSingletonCache} accessor, so the raw
 * global-singletons Symbol stays private to plugin-sql.
 */
async function preinitializePGlite(): Promise<void> {
  const singletons = getPgliteSingletonCache();

  // Only initialize if not already done
  if (singletons.pgLiteClientManager) {
    return;
  }

  console.log("[elizaOS] Pre-initializing PGlite for browser...");

  // Create PGlite with our browser-friendly loader
  const pglite = await createBrowserPGlite();

  // Create a minimal client manager wrapper
  const managerWrapper = {
    getConnection: () => pglite,
    isShuttingDown: () => false,
    initialize: async () => {},
    close: async () => {
      await pglite.close();
    },
  };
  singletons.pgLiteClientManager = managerWrapper;

  console.log("[elizaOS] PGlite pre-initialized successfully");
}

// ============================================================================
// Runtime Singleton
// ============================================================================

let runtimeInstance: AgentRuntime | null = null;
let initializationPromise: Promise<AgentRuntime> | null = null;
let selectedProviderName: InferenceProviderName | null = null;

// Session identifiers
const userId = uuidv4() as UUID;
const roomId = stringToUuid("eliza-chat-room");
const worldId = stringToUuid("eliza-chat-world");

/**
 * Get or create the AgentRuntime instance.
 * This is a singleton that is shared across the application.
 */
export async function getRuntime(): Promise<AgentRuntime> {
  // Return existing instance if available
  if (runtimeInstance) {
    return runtimeInstance;
  }

  // Return existing initialization promise if in progress
  if (initializationPromise) {
    return initializationPromise;
  }

  // Start initialization
  initializationPromise = initializeRuntime();
  runtimeInstance = await initializationPromise;
  initializationPromise = null;
  return runtimeInstance;
}

/**
 * Initialize a new AgentRuntime with PGlite and the selected LLM provider.
 */
async function initializeRuntime(): Promise<AgentRuntime> {
  console.log("[elizaOS] Initializing AgentRuntime...");

  // Pre-initialize PGlite before the SQL plugin runs
  await preinitializePGlite();

  const provider = await selectInferenceProvider();
  selectedProviderName = provider.name;
  console.log(`[elizaOS] Inference provider: ${provider.name}`);

  const character: Character = {
    ...elizaCharacter,
    settings: {
      ...elizaCharacter.settings,
      secrets: {
        ...elizaCharacter.settings?.secrets,
        [provider.secretKey]: provider.secretValue,
      },
    },
  };

  const runtime = new AgentRuntime({
    character,
    plugins: [
      sqlPlugin, // PGlite database for browser (uses our pre-initialized instance)
      provider.plugin, // Selected LLM inference provider
    ],
  });

  await runtime.initialize();

  // Setup the chat connection
  await runtime.ensureConnection({
    entityId: userId,
    roomId,
    worldId,
    userName: "User",
    source: "react-client",
    channelId: "eliza-chat",
    type: ChannelType.DM,
  });

  console.log("[elizaOS] AgentRuntime initialized successfully");
  return runtime;
}

/**
 * Send a message to the agent and get a response.
 *
 * This uses the AgentRuntime's model system, which routes to the selected
 * LLM inference provider.
 *
 * @param text - The user's message
 * @param onChunk - Optional callback for streaming response chunks
 * @returns The complete agent response
 */
export async function sendMessage(
  text: string,
  onChunk?: (chunk: string) => void,
): Promise<string> {
  const runtime = await getRuntime();

  if (!runtime.messageService) {
    throw new Error("Runtime message service not available");
  }

  const useStreaming = typeof onChunk === "function";
  let responseText = "";

  // Create message memory (the messageService will persist it)
  const messageMemory = createMessageMemory({
    id: uuidv4() as UUID,
    entityId: userId,
    roomId,
    content: {
      text,
      source: "client_chat",
      channelType: ChannelType.DM,
    },
  });

  const streamOptions = useStreaming
    ? {
        $typeName: "eliza.v1.MessageProcessingOptions",
        onStreamChunk: async (chunk: string): Promise<void> => {
          responseText += chunk;
          onChunk?.(chunk);
        },
      }
    : undefined;

  const result = await runtime.messageService.handleMessage(
    runtime,
    messageMemory,
    async (content: Content): Promise<Memory[]> => {
      // In non-streaming mode, callback is typically called with the final reply.
      if (!useStreaming && typeof content.text === "string") {
        responseText = content.text;
      }
      return [];
    },
    streamOptions,
  );

  if (!responseText && typeof result.responseContent?.text === "string") {
    responseText = result.responseContent.text;
  }

  return responseText;
}

/**
 * Get the initial greeting message shown after boot.
 */
export function getGreeting(): string {
  return "Hello! How can I help you today?";
}

/**
 * Name of the inference provider selected at runtime init
 * ("openai" / "openrouter" / "anthropic" / "elizacloud"), or null before init.
 */
export function getProviderName(): InferenceProviderName | null {
  return selectedProviderName;
}

/**
 * Check if the runtime is initialized.
 */
export function isRuntimeInitialized(): boolean {
  return runtimeInstance !== null;
}

/**
 * Stop and cleanup the runtime.
 */
export async function stopRuntime(): Promise<void> {
  if (runtimeInstance) {
    await runtimeInstance.stop();
    runtimeInstance = null;
  }
}
