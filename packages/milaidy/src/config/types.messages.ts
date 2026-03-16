import type { GroupChatConfig, NativeCommandsSetting } from "@elizaos/core";

// --- Queue types (merged from types.queue.ts) ---

export type QueueMode =
  | "steer"
  | "followup"
  | "collect"
  | "steer-backlog"
  | "steer+backlog"
  | "queue"
  | "interrupt";
export type QueueDropPolicy = "old" | "new" | "summarize";

export type QueueModeByProvider = {
  whatsapp?: QueueMode;
  telegram?: QueueMode;
  discord?: QueueMode;
  googlechat?: QueueMode;
  slack?: QueueMode;
  signal?: QueueMode;
  imessage?: QueueMode;
  msteams?: QueueMode;
  webchat?: QueueMode;
};

// --- TTS types (merged from types.tts.ts) ---

export type TtsProvider = "elevenlabs" | "openai" | "edge";

export type TtsMode = "final" | "all";

export type TtsAutoMode = "off" | "always" | "inbound" | "tagged";

export type TtsModelOverrideConfig = {
  /** Enable model-provided overrides for TTS. */
  enabled?: boolean;
  /** Allow model-provided TTS text blocks. */
  allowText?: boolean;
  /** Allow model-provided provider override. */
  allowProvider?: boolean;
  /** Allow model-provided voice/voiceId override. */
  allowVoice?: boolean;
  /** Allow model-provided modelId override. */
  allowModelId?: boolean;
  /** Allow model-provided voice settings override. */
  allowVoiceSettings?: boolean;
  /** Allow model-provided normalization or language overrides. */
  allowNormalization?: boolean;
  /** Allow model-provided seed override. */
  allowSeed?: boolean;
};

export type TtsConfig = {
  /** Auto-TTS mode (preferred). */
  auto?: TtsAutoMode;
  /** Legacy: enable auto-TTS when `auto` is not set. */
  enabled?: boolean;
  /** Apply TTS to final replies only or to all replies (tool/block/final). */
  mode?: TtsMode;
  /** Primary TTS provider (fallbacks are automatic). */
  provider?: TtsProvider;
  /** Optional model override for TTS auto-summary (provider/model or alias). */
  summaryModel?: string;
  /** Allow the model to override TTS parameters. */
  modelOverrides?: TtsModelOverrideConfig;
  /** ElevenLabs configuration. */
  elevenlabs?: {
    apiKey?: string;
    baseUrl?: string;
    voiceId?: string;
    modelId?: string;
    seed?: number;
    applyTextNormalization?: "auto" | "on" | "off";
    languageCode?: string;
    voiceSettings?: {
      stability?: number;
      similarityBoost?: number;
      style?: number;
      useSpeakerBoost?: boolean;
      speed?: number;
    };
  };
  /** OpenAI configuration. */
  openai?: {
    apiKey?: string;
    model?: string;
    voice?: string;
  };
  /** Microsoft Edge (node-edge-tts) configuration. */
  edge?: {
    /** Explicitly allow Edge TTS usage (no API key required). */
    enabled?: boolean;
    voice?: string;
    lang?: string;
    outputFormat?: string;
    pitch?: string;
    rate?: string;
    volume?: string;
    saveSubtitles?: boolean;
    proxy?: string;
    timeoutMs?: number;
  };
  /** Optional path for local TTS user preferences JSON. */
  prefsPath?: string;
  /** Hard cap for text sent to TTS (chars). */
  maxTextLength?: number;
  /** API request timeout (ms). */
  timeoutMs?: number;
};

export type QueueConfig = {
  mode?: QueueMode;
  byChannel?: QueueModeByProvider;
  debounceMs?: number;
  /** Per-channel debounce overrides (ms). */
  debounceMsByChannel?: InboundDebounceByProvider;
  cap?: number;
  drop?: QueueDropPolicy;
};

export type InboundDebounceByProvider = Record<string, number>;

export type InboundDebounceConfig = {
  debounceMs?: number;
  byChannel?: InboundDebounceByProvider;
};

export type BroadcastStrategy = "parallel" | "sequential";

export type BroadcastConfig = {
  /** Default processing strategy for broadcast peers. */
  strategy?: BroadcastStrategy;
  /**
   * Map peer IDs to arrays of agent IDs that should ALL process messages.
   *
   * Note: the index signature includes `undefined` so `strategy?: ...` remains type-safe.
   */
  [peerId: string]: string[] | BroadcastStrategy | undefined;
};

export type MessagesConfig = {
  /**
   * Prefix auto-added to all outbound replies.
   *
   * - string: explicit prefix (may include template variables)
   * - special value: `"auto"` derives `[{agents.list[].identity.name}]` for the routed agent (when set)
   *
   * Supported template variables (case-insensitive):
   * - `{model}` - short model name (e.g., `claude-opus-4-5`, `gpt-5`)
   * - `{modelFull}` - full model identifier (e.g., `anthropic/claude-opus-4-5`)
   * - `{provider}` - provider name (e.g., `anthropic`, `openai`)
   * - `{thinkingLevel}` or `{think}` - current thinking level (`high`, `low`, `off`)
   * - `{identity.name}` or `{identityName}` - agent identity name
   *
   * Example: `"[{model} | think:{thinkingLevel}]"` → `"[claude-opus-4-5 | think:high]"`
   *
   * Unresolved variables remain as literal text (e.g., `{model}` if context unavailable).
   *
   * Default: none
   */
  responsePrefix?: string;
  groupChat?: GroupChatConfig;
  queue?: QueueConfig;
  /** Debounce rapid inbound messages per sender (global + per-channel overrides). */
  inbound?: InboundDebounceConfig;
  /** Emoji reaction used to acknowledge inbound messages (empty disables). */
  ackReaction?: string;
  /** When to send ack reactions. Default: "group-mentions". */
  ackReactionScope?: "group-mentions" | "group-all" | "direct" | "all";
  /** Remove ack reaction after reply is sent (default: false). */
  removeAckAfterReply?: boolean;
  /** Text-to-speech settings for outbound replies. */
  tts?: TtsConfig;
};

/** Audio configuration (placeholder for future audio-specific settings). */
export type AudioConfig = {
  [key: string]: unknown;
};

export type CommandsConfig = {
  /** Enable native command registration when supported (default: "auto"). */
  native?: NativeCommandsSetting;
  /** Enable native skill command registration when supported (default: "auto"). */
  nativeSkills?: NativeCommandsSetting;
  /** Enable text command parsing (default: true). */
  text?: boolean;
  /** Allow bash chat command (`!`; `/bash` alias) (default: false). */
  bash?: boolean;
  /** How long bash waits before backgrounding (default: 2000; 0 backgrounds immediately). */
  bashForegroundMs?: number;
  /** Allow /config command (default: false). */
  config?: boolean;
  /** Allow /debug command (default: false). */
  debug?: boolean;
  /** Allow restart commands/tools (default: false). */
  restart?: boolean;
  /** Enforce access-group allowlists/policies for commands (default: true). */
  useAccessGroups?: boolean;
};
