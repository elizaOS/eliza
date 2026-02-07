/**
 * Plugin TTS - Text-to-Speech coordinator for Eliza agents
 *
 * Provides a unified TTS interface that:
 * - Supports multiple providers (ElevenLabs, OpenAI, Edge, Simple Voice)
 * - Auto-selects providers based on available API keys
 * - Parses [[tts]] directives from messages
 * - Handles text processing and length limits
 * - Manages per-session TTS configuration
 */

import {
  EventType,
  type HookMessageSendingPayload,
  type IAgentRuntime,
  ModelType,
  type Plugin,
  type Provider,
  type ProviderResult,
  logger,
} from "@elizaos/core";

import {
  getTtsText,
  hasTtsDirective,
  parseJsonVoiceDirective,
  parseTtsDirective,
  stripTtsDirectives,
} from "./directive-parser";
import {
  cleanTextForTts,
  processTextForTts,
  truncateText,
} from "./text-processor";
import {
  DEFAULT_TTS_CONFIG,
  TTS_PROVIDER_API_KEYS,
  TTS_PROVIDER_PRIORITY,
  type TtsApplyKind,
  type TtsAutoMode,
  type TtsConfig,
  type TtsDirective,
  type TtsProvider,
  type TtsRequest,
  type TtsResult,
  type TtsSessionConfig,
} from "./types";

// Re-export everything
export * from "./types";
export * from "./directive-parser";
export * from "./text-processor";

// Session configurations
const sessionConfigs = new Map<string, TtsSessionConfig>();

/**
 * Get TTS configuration for a session
 */
export function getTtsConfig(roomId: string): TtsConfig {
  const session = sessionConfigs.get(roomId);
  return {
    ...DEFAULT_TTS_CONFIG,
    ...session,
  };
}

/**
 * Set TTS configuration for a session
 */
export function setTtsConfig(
  roomId: string,
  config: Partial<TtsSessionConfig>,
): void {
  const existing = sessionConfigs.get(roomId) ?? {};
  sessionConfigs.set(roomId, { ...existing, ...config });
}

/**
 * Clear TTS configuration for a session
 */
export function clearTtsConfig(roomId: string): void {
  sessionConfigs.delete(roomId);
}

/**
 * Check if a provider is available (has required API keys)
 */
export function isProviderAvailable(
  runtime: IAgentRuntime,
  provider: TtsProvider,
): boolean {
  if (provider === "auto") return true;

  const requiredKeys = TTS_PROVIDER_API_KEYS[provider];
  if (requiredKeys.length === 0) {
    return true; // No API key required
  }

  return requiredKeys.some((key) => {
    const value = runtime.getSetting(key);
    return value && String(value).trim() !== "";
  });
}

/**
 * Get the best available provider
 */
export function getBestProvider(
  runtime: IAgentRuntime,
  preferred?: TtsProvider,
): TtsProvider {
  // If preferred is specified and available, use it
  if (
    preferred &&
    preferred !== "auto" &&
    isProviderAvailable(runtime, preferred)
  ) {
    return preferred;
  }

  // Otherwise, find the first available provider in priority order
  for (const provider of TTS_PROVIDER_PRIORITY) {
    if (isProviderAvailable(runtime, provider)) {
      return provider;
    }
  }

  // Fallback to simple-voice (always available)
  return "simple-voice";
}

/**
 * Synthesize text to speech
 */
export async function synthesize(
  runtime: IAgentRuntime,
  request: TtsRequest,
): Promise<TtsResult> {
  const provider = getBestProvider(runtime, request.provider);

  logger.debug(`[TTS] Synthesizing with provider: ${provider}`);

  const params = {
    text: request.text,
    voice: request.voice,
    model: request.model,
    speed: request.speed,
    provider, // Pass provider hint for routing
  };

  try {
    const audio = await runtime.useModel(ModelType.TEXT_TO_SPEECH, params);

    return {
      audio: Buffer.isBuffer(audio) ? audio : Buffer.from(audio as ArrayBuffer),
      format: request.format ?? "mp3",
      provider,
    };
  } catch (error) {
    logger.error(`[TTS] Synthesis failed with ${provider}: ${error}`);
    throw error;
  }
}

/**
 * Check if TTS should be applied to a reply
 */
export function shouldApplyTts(
  config: TtsConfig,
  options: {
    inboundAudio?: boolean;
    kind?: TtsApplyKind;
    hasDirective?: boolean;
  },
): boolean {
  const { auto } = config;
  const { inboundAudio, kind, hasDirective } = options;

  // TTS is disabled
  if (auto === "off") {
    return false;
  }

  // Always apply TTS
  if (auto === "always") {
    return true;
  }

  // Only when inbound message had audio
  if (auto === "inbound") {
    return Boolean(inboundAudio);
  }

  // Only when [[tts]] directive is present
  if (auto === "tagged") {
    return Boolean(hasDirective);
  }

  return false;
}

/**
 * Apply TTS to a reply text if configured
 */
export async function maybeApplyTts(
  runtime: IAgentRuntime,
  roomId: string,
  text: string,
  options: {
    inboundAudio?: boolean;
    kind?: TtsApplyKind;
  },
): Promise<Buffer | null> {
  const config = getTtsConfig(roomId);
  const directive = parseTtsDirective(text);
  const hasDirective = Boolean(directive);

  // Check if we should apply TTS
  if (!shouldApplyTts(config, { ...options, hasDirective })) {
    return null;
  }

  // Get the text to synthesize
  const ttsText = getTtsText(text, directive);

  // Process the text (clean, validate length, maybe summarize)
  const processed = await processTextForTts(runtime, ttsText, {
    maxLength: config.maxLength,
    summarize: config.summarize,
  });

  if (!processed) {
    logger.debug("[TTS] Text too short or invalid for TTS");
    return null;
  }

  // Synthesize
  try {
    const result = await synthesize(runtime, {
      text: processed,
      provider: directive?.provider ?? config.provider,
      voice: directive?.voice ?? config.voice,
      model: directive?.model ?? config.model,
      speed: directive?.speed,
    });

    return result.audio;
  } catch (error) {
    logger.error(`[TTS] Failed to apply TTS: ${error}`);
    return null;
  }
}

/**
 * Format TTS configuration for display
 */
export function formatTtsConfig(config: TtsConfig): string {
  const lines: string[] = [];
  lines.push(`Auto: ${config.auto}`);
  lines.push(`Provider: ${config.provider}`);
  lines.push(`Max length: ${config.maxLength}`);
  lines.push(`Summarize: ${config.summarize ? "yes" : "no"}`);
  if (config.voice) {
    lines.push(`Voice: ${config.voice}`);
  }
  return lines.join("\n");
}

/**
 * Provider that exposes current TTS configuration
 */
export const ttsConfigProvider: Provider = {
  name: "TTS_CONFIG",
  description: "Current text-to-speech configuration",
  dynamic: true,

  async get(runtime, message, _state): Promise<ProviderResult> {
    const config = getTtsConfig(message.roomId);
    const bestProvider = getBestProvider(runtime, config.provider);

    return {
      text: formatTtsConfig(config),
      values: {
        ttsAuto: config.auto,
        ttsProvider: config.provider,
        ttsActiveProvider: bestProvider,
        ttsMaxLength: config.maxLength,
        ttsSummarize: config.summarize,
        ttsVoice: config.voice ?? "",
      },
      data: { config },
    };
  },
};

/**
 * Plugin TTS
 *
 * Coordinates text-to-speech synthesis across multiple providers.
 * Works with existing TTS plugins (plugin-edge-tts, plugin-elevenlabs, etc.)
 * to provide a unified interface.
 */
export const ttsPlugin: Plugin = {
  name: "tts",
  description:
    "Text-to-speech coordinator with multi-provider support and [[tts]] directives",

  providers: [ttsConfigProvider],

  events: {
    [EventType.HOOK_MESSAGE_SENDING]: [
      async (payload: HookMessageSendingPayload) => {
        if (!payload.runtime || !payload.content || payload.cancel) return;

        const runtime = payload.runtime;
        const roomId = payload.to ?? "";
        const config = getTtsConfig(roomId);

        // Check JSON voice directive (openclaw-classic format)
        const jsonDirective = parseJsonVoiceDirective(payload.content);

        // Check [[tts]] directive
        const tagDirective = parseTtsDirective(payload.content);
        const hasDirective = Boolean(jsonDirective || tagDirective);

        const inboundAudio = Boolean(
          payload.metadata && "inboundAudio" in payload.metadata && payload.metadata.inboundAudio,
        );

        if (!shouldApplyTts(config, { inboundAudio, hasDirective })) {
          return;
        }

        // Determine text to synthesize and any directive overrides
        const directive = jsonDirective?.directive ?? tagDirective;
        const textToSpeak = jsonDirective
          ? jsonDirective.cleanedText
          : getTtsText(payload.content, tagDirective);

        if (!textToSpeak.trim()) return;

        try {
          const result = await synthesize(runtime, {
            text: textToSpeak,
            provider: directive?.provider ?? config.provider,
            voice: directive?.voice ?? config.voice,
            model: directive?.model ?? config.model,
            speed: directive?.speed,
          });

          // Attach TTS audio to message metadata for the channel to send
          payload.metadata = {
            ...payload.metadata,
            ttsAudio: result.audio,
            ttsFormat: result.format,
            ttsProvider: result.provider,
          };

          // If we parsed a JSON voice directive, replace the content with cleaned text
          if (jsonDirective) {
            payload.content = jsonDirective.cleanedText;
          }

          logger.debug(
            `[TTS] Generated ${result.format} audio via ${result.provider} for room ${roomId}`,
          );
        } catch (err) {
          logger.warn(
            `[TTS] Failed to generate speech: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      },
    ],
  },

  config: {
    TTS_AUTO_MODE: "off",
    TTS_DEFAULT_PROVIDER: "auto",
    TTS_MAX_LENGTH: "1500",
    TTS_SUMMARIZE: "true",
    TTS_DEFAULT_VOICE: "",
  },

  tests: [
    {
      name: "tts-directives",
      tests: [
        {
          name: "Detect TTS directive",
          fn: async (_runtime: IAgentRuntime) => {
            if (!hasTtsDirective("Hello [[tts]] world")) {
              throw new Error("Should detect [[tts]] directive");
            }
            if (!hasTtsDirective("[[tts:provider=elevenlabs]] Hello")) {
              throw new Error("Should detect [[tts:provider=...]] directive");
            }
            if (!hasTtsDirective("[[tts:text]]Hello[[/tts:text]]")) {
              throw new Error("Should detect [[tts:text]] directive");
            }
            if (hasTtsDirective("No directive here")) {
              throw new Error("Should not detect directive in plain text");
            }
            logger.success("TTS directive detection works correctly");
          },
        },
        {
          name: "Parse TTS directive with options",
          fn: async (_runtime: IAgentRuntime) => {
            const directive = parseTtsDirective(
              "[[tts:provider=elevenlabs voice=alloy speed=1.5]] Hello",
            );
            if (!directive) {
              throw new Error("Should parse directive");
            }
            if (directive.provider !== "elevenlabs") {
              throw new Error(
                `Expected provider 'elevenlabs', got '${directive.provider}'`,
              );
            }
            if (directive.voice !== "alloy") {
              throw new Error(
                `Expected voice 'alloy', got '${directive.voice}'`,
              );
            }
            if (directive.speed !== 1.5) {
              throw new Error(`Expected speed 1.5, got ${directive.speed}`);
            }
            logger.success("TTS directive parsing works correctly");
          },
        },
        {
          name: "Parse TTS text block",
          fn: async (_runtime: IAgentRuntime) => {
            const directive = parseTtsDirective(
              "Some text [[tts:text]]This is the TTS text[[/tts:text]] more text",
            );
            if (!directive) {
              throw new Error("Should parse directive");
            }
            if (directive.text !== "This is the TTS text") {
              throw new Error(
                `Expected text 'This is the TTS text', got '${directive.text}'`,
              );
            }
            logger.success("TTS text block parsing works correctly");
          },
        },
        {
          name: "Strip TTS directives",
          fn: async (_runtime: IAgentRuntime) => {
            const text =
              "Hello [[tts:provider=elevenlabs]] world [[tts:text]]TTS text[[/tts:text]]";
            const stripped = stripTtsDirectives(text);
            if (stripped !== "Hello world") {
              throw new Error(`Expected 'Hello world', got '${stripped}'`);
            }
            logger.success("TTS directive stripping works correctly");
          },
        },
        {
          name: "Get TTS text with directive",
          fn: async (_runtime: IAgentRuntime) => {
            const text = "Message [[tts:text]]Custom TTS[[/tts:text]]";
            const directive = parseTtsDirective(text);
            const ttsText = getTtsText(text, directive);
            if (ttsText !== "Custom TTS") {
              throw new Error(`Expected 'Custom TTS', got '${ttsText}'`);
            }
            logger.success("TTS text extraction works correctly");
          },
        },
        {
          name: "Get TTS text without directive",
          fn: async (_runtime: IAgentRuntime) => {
            const text = "Plain message";
            const directive = parseTtsDirective(text);
            const ttsText = getTtsText(text, directive);
            if (ttsText !== "Plain message") {
              throw new Error(`Expected 'Plain message', got '${ttsText}'`);
            }
            logger.success("TTS text fallback works correctly");
          },
        },
      ],
    },
    {
      name: "tts-text-processing",
      tests: [
        {
          name: "Clean text for TTS",
          fn: async (_runtime: IAgentRuntime) => {
            const text = "**Bold** and `code` with https://example.com";
            const cleaned = cleanTextForTts(text);
            if (cleaned !== "Bold and [code] with [link]") {
              throw new Error(`Expected clean text, got '${cleaned}'`);
            }
            logger.success("Text cleaning works correctly");
          },
        },
        {
          name: "Truncate text",
          fn: async (_runtime: IAgentRuntime) => {
            const text =
              "This is a long sentence. Another sentence here. And more text.";
            const truncated = truncateText(text, 40);
            if (truncated.length > 43) {
              // +3 for "..."
              throw new Error(
                `Expected truncated text, got length ${truncated.length}`,
              );
            }
            logger.success("Text truncation works correctly");
          },
        },
      ],
    },
    {
      name: "tts-config",
      tests: [
        {
          name: "Session config management",
          fn: async (_runtime: IAgentRuntime) => {
            const roomId = "test-room-tts";
            clearTtsConfig(roomId);

            setTtsConfig(roomId, { auto: "always", provider: "edge" });

            const config = getTtsConfig(roomId);
            if (config.auto !== "always") {
              throw new Error(`Expected auto 'always', got '${config.auto}'`);
            }
            if (config.provider !== "edge") {
              throw new Error(
                `Expected provider 'edge', got '${config.provider}'`,
              );
            }

            clearTtsConfig(roomId);
            logger.success("TTS config management works correctly");
          },
        },
        {
          name: "Should apply TTS logic",
          fn: async (_runtime: IAgentRuntime) => {
            // Off mode
            if (shouldApplyTts({ ...DEFAULT_TTS_CONFIG, auto: "off" }, {})) {
              throw new Error("Should not apply when auto is off");
            }

            // Always mode
            if (
              !shouldApplyTts({ ...DEFAULT_TTS_CONFIG, auto: "always" }, {})
            ) {
              throw new Error("Should apply when auto is always");
            }

            // Inbound mode
            if (
              shouldApplyTts({ ...DEFAULT_TTS_CONFIG, auto: "inbound" }, {})
            ) {
              throw new Error("Should not apply when inbound without audio");
            }
            if (
              !shouldApplyTts(
                { ...DEFAULT_TTS_CONFIG, auto: "inbound" },
                { inboundAudio: true },
              )
            ) {
              throw new Error("Should apply when inbound with audio");
            }

            // Tagged mode
            if (shouldApplyTts({ ...DEFAULT_TTS_CONFIG, auto: "tagged" }, {})) {
              throw new Error("Should not apply when tagged without directive");
            }
            if (
              !shouldApplyTts(
                { ...DEFAULT_TTS_CONFIG, auto: "tagged" },
                { hasDirective: true },
              )
            ) {
              throw new Error("Should apply when tagged with directive");
            }

            logger.success("TTS apply logic works correctly");
          },
        },
      ],
    },
  ],

  async init(config, runtime) {
    logger.log("[plugin-tts] Initializing TTS coordinator");

    const autoMode = (config.TTS_AUTO_MODE as TtsAutoMode) ?? "off";
    const provider = (config.TTS_DEFAULT_PROVIDER as TtsProvider) ?? "auto";

    logger.log(
      `[plugin-tts] Auto mode: ${autoMode}, Default provider: ${provider}`,
    );

    // Log available providers
    const available = TTS_PROVIDER_PRIORITY.filter((p) =>
      isProviderAvailable(runtime, p),
    );
    logger.log(
      `[plugin-tts] Available providers: ${available.join(", ") || "none"}`,
    );
  },
};

export default ttsPlugin;
