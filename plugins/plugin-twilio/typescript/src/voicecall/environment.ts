import type { IAgentRuntime } from "@elizaos/core";
import { z } from "zod";
import type { CallMode, ProviderName } from "./types";

// -----------------------------------------------------------------------------
// Phone Number Validation
// -----------------------------------------------------------------------------

export const E164Schema = z
  .string()
  .regex(/^\+[1-9]\d{1,14}$/, "Expected E.164 format, e.g. +15550001234");

// -----------------------------------------------------------------------------
// Inbound Policy
// -----------------------------------------------------------------------------

export const InboundPolicySchema = z.enum(["disabled", "allowlist", "pairing", "open"]);
export type InboundPolicy = z.infer<typeof InboundPolicySchema>;

// -----------------------------------------------------------------------------
// Provider-Specific Configuration
// -----------------------------------------------------------------------------

export const TwilioConfigSchema = z
  .object({
    accountSid: z.string().min(1).optional(),
    authToken: z.string().min(1).optional(),
  })
  .strict();
export type TwilioProviderConfig = z.infer<typeof TwilioConfigSchema>;

// -----------------------------------------------------------------------------
// STT/TTS Configuration
// -----------------------------------------------------------------------------

export const SttConfigSchema = z
  .object({
    provider: z.literal("openai").default("openai"),
    model: z.string().min(1).default("whisper-1"),
  })
  .strict()
  .default({ provider: "openai", model: "whisper-1" });
export type SttConfig = z.infer<typeof SttConfigSchema>;

export const TtsConfigSchema = z
  .object({
    provider: z.enum(["openai", "elevenlabs"]).default("openai"),
    voice: z.string().optional(),
    model: z.string().optional(),
  })
  .strict()
  .optional();
export type TtsConfig = z.infer<typeof TtsConfigSchema>;

// -----------------------------------------------------------------------------
// Webhook Server Configuration
// -----------------------------------------------------------------------------

export const WebhookServeConfigSchema = z
  .object({
    port: z.number().int().positive().default(3334),
    bind: z.string().default("127.0.0.1"),
    path: z.string().min(1).default("/voice/webhook"),
  })
  .strict()
  .default({ port: 3334, bind: "127.0.0.1", path: "/voice/webhook" });
export type WebhookServeConfig = z.infer<typeof WebhookServeConfigSchema>;

// -----------------------------------------------------------------------------
// Streaming Configuration
// -----------------------------------------------------------------------------

export const StreamingConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    sttProvider: z.enum(["openai-realtime"]).default("openai-realtime"),
    openaiApiKey: z.string().min(1).optional(),
    sttModel: z.string().min(1).default("gpt-5-transcribe"),
    silenceDurationMs: z.number().int().positive().default(800),
    vadThreshold: z.number().min(0).max(1).default(0.5),
    streamPath: z.string().min(1).default("/voice/stream"),
  })
  .strict()
  .default({
    enabled: false,
    sttProvider: "openai-realtime",
    sttModel: "gpt-5-transcribe",
    silenceDurationMs: 800,
    vadThreshold: 0.5,
    streamPath: "/voice/stream",
  });
export type StreamingConfig = z.infer<typeof StreamingConfigSchema>;

// -----------------------------------------------------------------------------
// Outbound Configuration
// -----------------------------------------------------------------------------

export const OutboundConfigSchema = z
  .object({
    defaultMode: z.enum(["notify", "conversation"]).default("notify"),
    notifyHangupDelaySec: z.number().int().nonnegative().default(3),
  })
  .strict()
  .default({ defaultMode: "notify", notifyHangupDelaySec: 3 });
export type OutboundConfig = z.infer<typeof OutboundConfigSchema>;

// -----------------------------------------------------------------------------
// Main Voice Call Configuration Schema
// -----------------------------------------------------------------------------

export const voiceCallEnvSchema = z.object({
  VOICE_CALL_PROVIDER: z.enum(["twilio", "mock"]).optional(),
  VOICE_CALL_FROM_NUMBER: E164Schema.optional(),
  VOICE_CALL_TO_NUMBER: E164Schema.optional(),
  VOICE_CALL_WEBHOOK_PORT: z.coerce.number().int().positive().optional(),
  VOICE_CALL_WEBHOOK_PATH: z.string().optional(),
  VOICE_CALL_PUBLIC_URL: z.string().url().optional(),
  VOICE_CALL_MAX_DURATION_SECONDS: z.coerce.number().int().positive().optional(),
  VOICE_CALL_MAX_CONCURRENT_CALLS: z.coerce.number().int().positive().optional(),
  VOICE_CALL_INBOUND_POLICY: InboundPolicySchema.optional(),
  VOICE_CALL_ALLOW_FROM: z.string().optional(),
  VOICE_CALL_INBOUND_GREETING: z.string().optional(),
  VOICE_CALL_SKIP_SIGNATURE_VERIFICATION: z.coerce.boolean().optional(),

  // Twilio
  TWILIO_ACCOUNT_SID: z.string().min(1).optional(),
  TWILIO_AUTH_TOKEN: z.string().min(1).optional(),
  TWILIO_PHONE_NUMBER: E164Schema.optional(),

  // OpenAI (for STT/TTS)
  OPENAI_API_KEY: z.string().min(1).optional(),
});

export type VoiceCallEnvConfig = z.infer<typeof voiceCallEnvSchema>;

// -----------------------------------------------------------------------------
// Voice Call Settings (Runtime Configuration)
// -----------------------------------------------------------------------------

export interface VoiceCallSettings {
  enabled: boolean;
  provider: ProviderName;
  fromNumber: string;
  toNumber?: string;
  inboundPolicy: InboundPolicy;
  allowFrom: string[];
  inboundGreeting?: string;
  outbound: {
    defaultMode: CallMode;
    notifyHangupDelaySec: number;
  };
  maxDurationSeconds: number;
  silenceTimeoutMs: number;
  transcriptTimeoutMs: number;
  ringTimeoutMs: number;
  maxConcurrentCalls: number;
  serve: {
    port: number;
    bind: string;
    path: string;
  };
  streaming: {
    enabled: boolean;
    sttProvider: string;
    openaiApiKey?: string;
    sttModel: string;
    silenceDurationMs: number;
    vadThreshold: number;
    streamPath: string;
  };
  publicUrl?: string;
  skipSignatureVerification: boolean;
  twilio?: TwilioProviderConfig;
  stt?: SttConfig;
  tts?: TtsConfig;
}

// -----------------------------------------------------------------------------
// Configuration Helpers
// -----------------------------------------------------------------------------

function parseAllowFrom(value: string | undefined): string[] {
  if (!value) return [];
  const trimmed = value.trim();
  if (!trimmed) return [];

  if (trimmed.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {
        return parsed.filter((n): n is string => typeof n === "string" && n.trim() !== "");
      }
    } catch {
      // Fall through to comma-separated parsing
    }
  }

  return trimmed
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

export async function validateVoiceCallConfig(
  runtime: IAgentRuntime,
): Promise<VoiceCallEnvConfig | null> {
  try {
    const config = {
      VOICE_CALL_PROVIDER:
        runtime.getSetting("VOICE_CALL_PROVIDER") || process.env.VOICE_CALL_PROVIDER,
      VOICE_CALL_FROM_NUMBER:
        runtime.getSetting("VOICE_CALL_FROM_NUMBER") ||
        runtime.getSetting("TWILIO_PHONE_NUMBER") ||
        process.env.VOICE_CALL_FROM_NUMBER ||
        process.env.TWILIO_PHONE_NUMBER,
      VOICE_CALL_TO_NUMBER:
        runtime.getSetting("VOICE_CALL_TO_NUMBER") || process.env.VOICE_CALL_TO_NUMBER,
      VOICE_CALL_WEBHOOK_PORT:
        runtime.getSetting("VOICE_CALL_WEBHOOK_PORT") || process.env.VOICE_CALL_WEBHOOK_PORT,
      VOICE_CALL_WEBHOOK_PATH:
        runtime.getSetting("VOICE_CALL_WEBHOOK_PATH") || process.env.VOICE_CALL_WEBHOOK_PATH,
      VOICE_CALL_PUBLIC_URL:
        runtime.getSetting("VOICE_CALL_PUBLIC_URL") || process.env.VOICE_CALL_PUBLIC_URL,
      VOICE_CALL_MAX_DURATION_SECONDS:
        runtime.getSetting("VOICE_CALL_MAX_DURATION_SECONDS") ||
        process.env.VOICE_CALL_MAX_DURATION_SECONDS,
      VOICE_CALL_MAX_CONCURRENT_CALLS:
        runtime.getSetting("VOICE_CALL_MAX_CONCURRENT_CALLS") ||
        process.env.VOICE_CALL_MAX_CONCURRENT_CALLS,
      VOICE_CALL_INBOUND_POLICY:
        runtime.getSetting("VOICE_CALL_INBOUND_POLICY") || process.env.VOICE_CALL_INBOUND_POLICY,
      VOICE_CALL_ALLOW_FROM:
        runtime.getSetting("VOICE_CALL_ALLOW_FROM") || process.env.VOICE_CALL_ALLOW_FROM,
      VOICE_CALL_INBOUND_GREETING:
        runtime.getSetting("VOICE_CALL_INBOUND_GREETING") ||
        process.env.VOICE_CALL_INBOUND_GREETING,
      VOICE_CALL_SKIP_SIGNATURE_VERIFICATION:
        runtime.getSetting("VOICE_CALL_SKIP_SIGNATURE_VERIFICATION") ||
        process.env.VOICE_CALL_SKIP_SIGNATURE_VERIFICATION,
      TWILIO_ACCOUNT_SID:
        runtime.getSetting("TWILIO_ACCOUNT_SID") || process.env.TWILIO_ACCOUNT_SID,
      TWILIO_AUTH_TOKEN: runtime.getSetting("TWILIO_AUTH_TOKEN") || process.env.TWILIO_AUTH_TOKEN,
      TWILIO_PHONE_NUMBER:
        runtime.getSetting("TWILIO_PHONE_NUMBER") || process.env.TWILIO_PHONE_NUMBER,
      OPENAI_API_KEY: runtime.getSetting("OPENAI_API_KEY") || process.env.OPENAI_API_KEY,
    };

    return voiceCallEnvSchema.parse(config);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const errorMessages = error.issues
        .map((err) => `${err.path.join(".")}: ${err.message}`)
        .join("\n");
      console.warn(`Voice Call configuration validation failed:\n${errorMessages}`);
    }
    return null;
  }
}

export function buildVoiceCallSettings(config: VoiceCallEnvConfig): VoiceCallSettings {
  if (!config.VOICE_CALL_PROVIDER) {
    throw new Error("VOICE_CALL_PROVIDER is required. Supported providers: twilio, mock");
  }
  const provider = config.VOICE_CALL_PROVIDER as ProviderName;

  return {
    enabled: !!config.VOICE_CALL_PROVIDER,
    provider,
    fromNumber: config.VOICE_CALL_FROM_NUMBER || config.TWILIO_PHONE_NUMBER || "",
    toNumber: config.VOICE_CALL_TO_NUMBER,
    inboundPolicy: config.VOICE_CALL_INBOUND_POLICY || "disabled",
    allowFrom: parseAllowFrom(config.VOICE_CALL_ALLOW_FROM),
    inboundGreeting: config.VOICE_CALL_INBOUND_GREETING,
    outbound: {
      defaultMode: "notify",
      notifyHangupDelaySec: 3,
    },
    maxDurationSeconds: config.VOICE_CALL_MAX_DURATION_SECONDS || 300,
    silenceTimeoutMs: 800,
    transcriptTimeoutMs: 180000,
    ringTimeoutMs: 30000,
    maxConcurrentCalls: config.VOICE_CALL_MAX_CONCURRENT_CALLS || 1,
    serve: {
      port: config.VOICE_CALL_WEBHOOK_PORT || 3334,
      bind: "127.0.0.1",
      path: config.VOICE_CALL_WEBHOOK_PATH || "/voice/webhook",
    },
    streaming: {
      enabled: false,
      sttProvider: "openai-realtime",
      openaiApiKey: config.OPENAI_API_KEY,
      sttModel: "gpt-5-transcribe",
      silenceDurationMs: 800,
      vadThreshold: 0.5,
      streamPath: "/voice/stream",
    },
    publicUrl: config.VOICE_CALL_PUBLIC_URL,
    skipSignatureVerification: config.VOICE_CALL_SKIP_SIGNATURE_VERIFICATION || false,
    twilio:
      provider === "twilio"
        ? {
            accountSid: config.TWILIO_ACCOUNT_SID,
            authToken: config.TWILIO_AUTH_TOKEN,
          }
        : undefined,
  };
}

export function validateProviderConfig(settings: VoiceCallSettings): {
  valid: boolean;
  errors: string[];
} {
  const errors: string[] = [];

  if (!settings.enabled) {
    return { valid: true, errors: [] };
  }

  if (!settings.provider) {
    errors.push("VOICE_CALL_PROVIDER is required");
  }

  if (!settings.fromNumber) {
    errors.push("VOICE_CALL_FROM_NUMBER is required");
  }

  if (settings.provider === "twilio") {
    if (!settings.twilio?.accountSid) {
      errors.push("TWILIO_ACCOUNT_SID is required for Twilio provider");
    }
    if (!settings.twilio?.authToken) {
      errors.push("TWILIO_AUTH_TOKEN is required for Twilio provider");
    }
  }

  return { valid: errors.length === 0, errors };
}
