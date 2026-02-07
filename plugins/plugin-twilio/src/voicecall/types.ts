import type { Content } from "@elizaos/core";
import { z } from "zod";

// -----------------------------------------------------------------------------
// Utility Functions
// -----------------------------------------------------------------------------

/**
 * Validates that a phone number is in E.164 format.
 * E.164 format: + followed by country code and subscriber number, typically 10-15 digits total.
 */
export function isValidE164(phone: string): boolean {
  return /^\+[1-9]\d{9,14}$/.test(phone);
}

// -----------------------------------------------------------------------------
// Provider Identifiers
// -----------------------------------------------------------------------------

export const ProviderNameSchema = z.enum(["twilio", "mock"]);
export type ProviderName = z.infer<typeof ProviderNameSchema>;

// -----------------------------------------------------------------------------
// Core Call Identifiers
// -----------------------------------------------------------------------------

/** Internal call identifier (UUID) */
export type CallId = string;

/** Provider-specific call identifier */
export type ProviderCallId = string;

// -----------------------------------------------------------------------------
// Call Lifecycle States
// -----------------------------------------------------------------------------

export const CallStateSchema = z.enum([
  // Non-terminal states
  "initiated",
  "ringing",
  "answered",
  "active",
  "speaking",
  "listening",
  // Terminal states
  "completed",
  "hangup-user",
  "hangup-bot",
  "timeout",
  "error",
  "failed",
  "no-answer",
  "busy",
  "voicemail",
]);
export type CallState = z.infer<typeof CallStateSchema>;

export const TerminalStates = new Set<CallState>([
  "completed",
  "hangup-user",
  "hangup-bot",
  "timeout",
  "error",
  "failed",
  "no-answer",
  "busy",
  "voicemail",
]);

export const EndReasonSchema = z.enum([
  "completed",
  "hangup-user",
  "hangup-bot",
  "timeout",
  "error",
  "failed",
  "no-answer",
  "busy",
  "voicemail",
]);
export type EndReason = z.infer<typeof EndReasonSchema>;

// -----------------------------------------------------------------------------
// Call Direction
// -----------------------------------------------------------------------------

export const CallDirectionSchema = z.enum(["outbound", "inbound"]);
export type CallDirection = z.infer<typeof CallDirectionSchema>;

// -----------------------------------------------------------------------------
// Call Mode
// -----------------------------------------------------------------------------

/**
 * Call mode determines how outbound calls behave:
 * - "notify": Deliver message and auto-hangup after delay (one-way notification)
 * - "conversation": Stay open for back-and-forth until explicit end or timeout
 */
export const CallModeSchema = z.enum(["notify", "conversation"]);
export type CallMode = z.infer<typeof CallModeSchema>;

// -----------------------------------------------------------------------------
// Normalized Call Events
// -----------------------------------------------------------------------------

const BaseEventSchema = z.object({
  id: z.string(),
  callId: z.string(),
  providerCallId: z.string().optional(),
  timestamp: z.number(),
  direction: z.enum(["inbound", "outbound"]).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
});

export const NormalizedEventSchema = z.discriminatedUnion("type", [
  BaseEventSchema.extend({ type: z.literal("call.initiated") }),
  BaseEventSchema.extend({ type: z.literal("call.ringing") }),
  BaseEventSchema.extend({ type: z.literal("call.answered") }),
  BaseEventSchema.extend({ type: z.literal("call.active") }),
  BaseEventSchema.extend({
    type: z.literal("call.speaking"),
    text: z.string(),
  }),
  BaseEventSchema.extend({
    type: z.literal("call.speech"),
    transcript: z.string(),
    isFinal: z.boolean(),
    confidence: z.number().min(0).max(1).optional(),
  }),
  BaseEventSchema.extend({
    type: z.literal("call.silence"),
    durationMs: z.number(),
  }),
  BaseEventSchema.extend({
    type: z.literal("call.dtmf"),
    digits: z.string(),
  }),
  BaseEventSchema.extend({
    type: z.literal("call.ended"),
    reason: EndReasonSchema,
  }),
  BaseEventSchema.extend({
    type: z.literal("call.error"),
    error: z.string(),
    retryable: z.boolean().optional(),
  }),
]);
export type NormalizedEvent = z.infer<typeof NormalizedEventSchema>;

// -----------------------------------------------------------------------------
// Transcript
// -----------------------------------------------------------------------------

export const TranscriptEntrySchema = z.object({
  timestamp: z.number(),
  speaker: z.enum(["bot", "user"]),
  text: z.string(),
  isFinal: z.boolean().default(true),
});
export type TranscriptEntry = z.infer<typeof TranscriptEntrySchema>;

// -----------------------------------------------------------------------------
// Call Record
// -----------------------------------------------------------------------------

export const CallRecordSchema = z.object({
  callId: z.string(),
  providerCallId: z.string().optional(),
  provider: ProviderNameSchema,
  direction: CallDirectionSchema,
  state: CallStateSchema,
  from: z.string(),
  to: z.string(),
  sessionKey: z.string().optional(),
  startedAt: z.number(),
  answeredAt: z.number().optional(),
  endedAt: z.number().optional(),
  endReason: EndReasonSchema.optional(),
  transcript: z.array(TranscriptEntrySchema).default([]),
  processedEventIds: z.array(z.string()).default([]),
  metadata: z.record(z.string(), z.unknown()).optional(),
});
export type CallRecord = z.infer<typeof CallRecordSchema>;

// -----------------------------------------------------------------------------
// Webhook Types
// -----------------------------------------------------------------------------

export type WebhookVerificationResult = {
  ok: boolean;
  reason?: string;
};

export type WebhookContext = {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  url: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  query?: Record<string, string | string[] | undefined>;
  remoteAddress?: string;
};

export type ProviderWebhookParseResult = {
  events: NormalizedEvent[];
  providerResponseBody?: string;
  providerResponseHeaders?: Record<string, string>;
  statusCode?: number;
};

// -----------------------------------------------------------------------------
// Provider Method Types
// -----------------------------------------------------------------------------

export type InitiateCallInput = {
  callId: CallId;
  from: string;
  to: string;
  webhookUrl: string;
  clientState?: Record<string, string>;
  inlineTwiml?: string;
};

export type InitiateCallResult = {
  providerCallId: ProviderCallId;
  status: "initiated" | "queued";
};

export type HangupCallInput = {
  callId: CallId;
  providerCallId: ProviderCallId;
  reason: EndReason;
};

export type PlayTtsInput = {
  callId: CallId;
  providerCallId: ProviderCallId;
  text: string;
  voice?: string;
  locale?: string;
};

export type StartListeningInput = {
  callId: CallId;
  providerCallId: ProviderCallId;
  language?: string;
};

export type StopListeningInput = {
  callId: CallId;
  providerCallId: ProviderCallId;
};

// -----------------------------------------------------------------------------
// Outbound Call Options
// -----------------------------------------------------------------------------

export type OutboundCallOptions = {
  message?: string;
  mode?: CallMode;
};

// -----------------------------------------------------------------------------
// Tool Result Types
// -----------------------------------------------------------------------------

export type InitiateCallToolResult = {
  success: boolean;
  callId?: string;
  status?: "initiated" | "queued" | "no-answer" | "busy" | "failed";
  error?: string;
};

export type ContinueCallToolResult = {
  success: boolean;
  transcript?: string;
  error?: string;
};

export type SpeakToUserToolResult = {
  success: boolean;
  error?: string;
};

export type EndCallToolResult = {
  success: boolean;
  error?: string;
};

// -----------------------------------------------------------------------------
// Event Types
// -----------------------------------------------------------------------------

export enum VoiceCallEventTypes {
  CALL_INITIATED = "VOICE_CALL_INITIATED",
  CALL_RINGING = "VOICE_CALL_RINGING",
  CALL_ANSWERED = "VOICE_CALL_ANSWERED",
  CALL_ACTIVE = "VOICE_CALL_ACTIVE",
  CALL_SPEAKING = "VOICE_CALL_SPEAKING",
  CALL_SPEECH = "VOICE_CALL_SPEECH",
  CALL_SILENCE = "VOICE_CALL_SILENCE",
  CALL_DTMF = "VOICE_CALL_DTMF",
  CALL_ENDED = "VOICE_CALL_ENDED",
  CALL_ERROR = "VOICE_CALL_ERROR",
  SERVICE_STARTED = "VOICE_CALL_SERVICE_STARTED",
  SERVICE_STOPPED = "VOICE_CALL_SERVICE_STOPPED",
  WEBHOOK_REGISTERED = "VOICE_CALL_WEBHOOK_REGISTERED",
}

// -----------------------------------------------------------------------------
// Content Types
// -----------------------------------------------------------------------------

export interface VoiceCallContent extends Content {
  phoneNumber?: string;
  message?: string;
  mode?: CallMode;
}

// -----------------------------------------------------------------------------
// Probe Types
// -----------------------------------------------------------------------------

export interface VoiceCallServiceProbe {
  ok: boolean;
  provider?: ProviderName;
  webhookUrl?: string;
  activeCalls?: number;
  error?: string;
  latencyMs: number;
}

// -----------------------------------------------------------------------------
// Payload Types
// -----------------------------------------------------------------------------

export interface VoiceCallServiceStatusPayload {
  provider: ProviderName;
  webhookUrl?: string;
  activeCalls: number;
  timestamp: number;
}

export interface VoiceCallWebhookPayload {
  url: string;
  path: string;
  port?: number;
  timestamp: number;
}

export interface VoiceCallEventPayload {
  callId: string;
  providerCallId?: string;
  direction: CallDirection;
  from: string;
  to: string;
  state: CallState;
  timestamp: number;
}

export interface VoiceCallSpeechPayload extends VoiceCallEventPayload {
  transcript: string;
  isFinal: boolean;
  confidence?: number;
}
