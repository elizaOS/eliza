/**
 * Voice realtime WebSocket session wire protocol (client mirror of the
 * server contract defined in VOICE-INTEGRATION-DECISION-2026-07-10.md section
 * 7.2). This module is transport-agnostic and side-effect free: it only
 * declares the JSON control frames and the small helpers that parse/serialize
 * them, so the framing/ordering logic is unit-testable without a real
 * WebSocket, AudioContext, or MediaStream.
 *
 * Binary frames = audio. Text frames = JSON control. The first frame after
 * connect MUST be a JSON `hello` from the client.
 *
 * Design rules honored here:
 *   - The auth token travels in the first `hello` frame, never a header
 *     (WebView 113 cannot set custom WS headers reliably).
 *   - Uplink default is pcm16 linear16 16 kHz mono (matches Deepgram Flux
 *     ingest with zero transcode); downlink default is pcm16 16 kHz mono
 *     (matches Cartesia pcm_s16le output).
 *   - Every server state event carries a `traceId`.
 */

/** Wire protocol version. Bumped only on breaking control-frame changes. */
export const VOICE_SESSION_PROTOCOL_VERSION = 1 as const;

/** Uplink/downlink codecs negotiated in `hello`. */
export type VoiceSessionCodec = "pcm16" | "opus";

/** Default uplink codec: linear16 mono 16 kHz, Deepgram Flux native ingest. */
export const DEFAULT_UPLINK_CODEC: VoiceSessionCodec = "pcm16";
/** Default downlink codec: pcm16 mono 16 kHz, Cartesia pcm_s16le native. */
export const DEFAULT_DOWNLINK_CODEC: VoiceSessionCodec = "pcm16";
/** Canonical sample rate for both directions of the default codec path. */
export const VOICE_SESSION_SAMPLE_RATE = 16_000 as const;

// ── Client -> server control frames ────────────────────────────────────

export interface ClientHelloFrame {
  t: "hello";
  token: string;
  protocol: number;
  uplinkCodec: VoiceSessionCodec;
  downlinkCodec: VoiceSessionCodec;
  sampleRate: number;
}

export interface ClientAudioMetaFrame {
  t: "audio_meta";
  seq: number;
  codec: VoiceSessionCodec;
  sampleRate: number;
  channels: number;
}

export interface ClientBargeInFrame {
  t: "barge_in";
}

export interface ClientByeFrame {
  t: "bye";
}

export type ClientControlFrame =
  | ClientHelloFrame
  | ClientAudioMetaFrame
  | ClientBargeInFrame
  | ClientByeFrame;

// ── Server -> client control / state events ────────────────────────────

export interface ServerReadyEvent {
  t: "ready";
  sessionId: string;
  traceId: string;
}

export interface ServerSttPartialEvent {
  t: "stt_partial";
  text: string;
  traceId: string;
}

export interface ServerSttEagerEotEvent {
  t: "stt_eager_eot";
  traceId: string;
}

export interface ServerSttFinalEvent {
  t: "stt_final";
  text: string;
  traceId: string;
}

export interface ServerLlmFirstTextEvent {
  t: "llm_first_text";
  traceId: string;
}

/** Exact caption for a bounded, server-authorized spoken progress preamble. */
export interface ServerAssistantProgressEvent {
  t: "assistant_progress";
  text: string;
  traceId: string;
}

export interface ServerSpeakingStartEvent {
  t: "speaking_start";
  traceId: string;
}

export interface ServerSpeakingEndEvent {
  t: "speaking_end";
  traceId: string;
}

export type ServerTurnOutcome =
  | "spoken"
  | "displayed"
  | "no_response"
  | "error"
  | "stopped";

/** Authoritative terminal event for a committed turn that was not cancelled. */
export interface ServerTurnEndEvent {
  t: "turn_end";
  outcome: ServerTurnOutcome;
  traceId: string;
}

export interface ServerNavigateViewEvent {
  t: "navigate_view";
  viewId: string;
  viewPath?: string;
  subview?: string;
  traceId: string;
}

export type InterruptionReason = "acoustic" | "explicit";

export interface ServerInterruptedEvent {
  t: "interrupted";
  reason: InterruptionReason;
  traceId: string;
}

export interface ServerErrorEvent {
  t: "error";
  code: string;
  retryable: boolean;
  traceId?: string;
  /** Optional human-readable detail; never authoritative for control flow. */
  message?: string;
  /** Bounded upstream HTTP status forwarded for provider diagnostics. */
  upstreamStatus?: number;
  /** Bounded public upstream message forwarded by the voice bridge. */
  upstreamMessage?: string;
  /** Bounded, sanitized upstream response prefix for diagnostics. */
  upstreamSnippet?: string;
}

export interface ServerUsageEvent {
  t: "usage";
  sttMs: number;
  ttsChars: number;
  traceId: string;
}

export type ServerControlFrame =
  | ServerReadyEvent
  | ServerSttPartialEvent
  | ServerSttEagerEotEvent
  | ServerSttFinalEvent
  | ServerLlmFirstTextEvent
  | ServerAssistantProgressEvent
  | ServerSpeakingStartEvent
  | ServerSpeakingEndEvent
  | ServerTurnEndEvent
  | ServerNavigateViewEvent
  | ServerInterruptedEvent
  | ServerErrorEvent
  | ServerUsageEvent;

export type ServerControlType = ServerControlFrame["t"];

// ── Mint (POST /api/v1/voice/session) response ─────────────────────────

export interface VoiceSessionMintRequest {
  agentId: string;
  conversationId: string;
  transport: "websocket";
}

export interface VoiceSessionCodecOffer {
  codecs: VoiceSessionCodec[];
}

export interface VoiceSessionMintResponse {
  sessionId: string;
  wsUrl: string;
  token: string;
  expiresAt: number | string;
  uplink: VoiceSessionCodecOffer;
  downlink: VoiceSessionCodecOffer;
  iceServers?: unknown | null;
}

// ── Serialization / parsing (pure) ─────────────────────────────────────

/** Serialize a client control frame to a JSON text-frame payload. */
export function encodeClientControl(frame: ClientControlFrame): string {
  return JSON.stringify(frame);
}

/**
 * Parse a server text-frame payload into a typed control frame. Returns null
 * for anything that is not a recognized control frame (unknown `t`, malformed
 * JSON, non-object). Callers treat null as "ignore this frame", never throw,
 * so a single bad frame cannot kill a live session.
 */
export function parseServerControl(raw: string): ServerControlFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const frame = parsed as Record<string, unknown>;
  const t = frame.t;
  if (typeof t !== "string") return null;
  if (!isKnownServerType(t)) return null;
  const traceId = readBoundedString(frame.traceId);

  switch (t) {
    case "ready": {
      const sessionId = readBoundedString(frame.sessionId);
      return sessionId && traceId ? { t, sessionId, traceId } : null;
    }
    case "stt_partial":
    case "stt_final": {
      const text = readFrameText(frame.text);
      return text !== null && traceId ? { t, text, traceId } : null;
    }
    case "stt_eager_eot":
    case "llm_first_text":
    case "speaking_start":
    case "speaking_end":
      return traceId ? { t, traceId } : null;
    case "assistant_progress": {
      const text = readFrameText(frame.text, 160);
      return text !== null && text.trim().length > 0 && traceId
        ? { t, text, traceId }
        : null;
    }
    case "turn_end": {
      const outcome = frame.outcome;
      return traceId && isServerTurnOutcome(outcome)
        ? { t, outcome, traceId }
        : null;
    }
    case "navigate_view": {
      const viewId = readBoundedString(frame.viewId);
      const rawViewPath = frame.viewPath;
      const viewPath =
        rawViewPath === undefined ? null : readBoundedString(rawViewPath);
      const rawSubview = frame.subview;
      const subview =
        rawSubview === undefined ? null : readBoundedString(rawSubview);
      if (
        !viewId ||
        !traceId ||
        (rawViewPath !== undefined && !viewPath) ||
        (rawSubview !== undefined && !subview)
      ) {
        return null;
      }
      return {
        t,
        viewId,
        ...(viewPath ? { viewPath } : {}),
        ...(subview ? { subview } : {}),
        traceId,
      };
    }
    case "interrupted": {
      const reason = frame.reason;
      return traceId && (reason === "acoustic" || reason === "explicit")
        ? { t, reason, traceId }
        : null;
    }
    case "error": {
      const code = readBoundedString(frame.code);
      const retryable = frame.retryable;
      const rawTraceId = frame.traceId;
      const optionalTraceId =
        rawTraceId === undefined ? null : readBoundedString(rawTraceId);
      const rawMessage = frame.message;
      const message =
        rawMessage === undefined ? null : readFrameText(rawMessage, 2_048);
      const rawUpstreamStatus = frame.upstreamStatus;
      const upstreamStatus = readOptionalHttpStatus(rawUpstreamStatus);
      const rawUpstreamMessage = frame.upstreamMessage;
      const upstreamMessage =
        rawUpstreamMessage === undefined
          ? null
          : readFrameText(rawUpstreamMessage, 512);
      const rawUpstreamSnippet = frame.upstreamSnippet;
      const upstreamSnippet =
        rawUpstreamSnippet === undefined
          ? null
          : readFrameText(rawUpstreamSnippet, 512);
      if (
        !code ||
        typeof retryable !== "boolean" ||
        (rawTraceId !== undefined && !optionalTraceId) ||
        (rawMessage !== undefined && message === null) ||
        upstreamStatus === false ||
        (rawUpstreamMessage !== undefined && upstreamMessage === null) ||
        (rawUpstreamSnippet !== undefined && upstreamSnippet === null)
      ) {
        return null;
      }
      return {
        t,
        code,
        retryable,
        ...(optionalTraceId ? { traceId: optionalTraceId } : {}),
        ...(message !== null ? { message } : {}),
        ...(upstreamStatus !== null ? { upstreamStatus } : {}),
        ...(upstreamMessage !== null ? { upstreamMessage } : {}),
        ...(upstreamSnippet !== null ? { upstreamSnippet } : {}),
      };
    }
    case "usage": {
      const sttMs = readNonNegativeNumber(frame.sttMs);
      const ttsChars = readNonNegativeInteger(frame.ttsChars);
      return traceId && sttMs !== null && ttsChars !== null
        ? { t, sttMs, ttsChars, traceId }
        : null;
    }
  }
}

const SERVER_TYPES: ReadonlySet<string> = new Set<ServerControlType>([
  "ready",
  "stt_partial",
  "stt_eager_eot",
  "stt_final",
  "llm_first_text",
  "assistant_progress",
  "speaking_start",
  "speaking_end",
  "turn_end",
  "navigate_view",
  "interrupted",
  "error",
  "usage",
]);

function isKnownServerType(t: string): t is ServerControlType {
  return SERVER_TYPES.has(t);
}

function readBoundedString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized.length > 0 && normalized.length <= 256 ? normalized : null;
}

function readFrameText(value: unknown, maxLength = 32_768): string | null {
  return typeof value === "string" && value.length <= maxLength ? value : null;
}

function isServerTurnOutcome(value: unknown): value is ServerTurnOutcome {
  return (
    value === "spoken" ||
    value === "displayed" ||
    value === "no_response" ||
    value === "error" ||
    value === "stopped"
  );
}

function readNonNegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}

function readNonNegativeInteger(value: unknown): number | null {
  const parsed = readNonNegativeNumber(value);
  return parsed !== null && Number.isInteger(parsed) ? parsed : null;
}

function readOptionalHttpStatus(value: unknown): number | null | false {
  if (value === undefined) return null;
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 100 &&
    value <= 599
    ? value
    : false;
}

/** Type guard: is this mint response usable (has url + token + sessionId). */
export function isUsableMintResponse(
  value: unknown,
): value is VoiceSessionMintResponse {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sessionId === "string" &&
    v.sessionId.length > 0 &&
    typeof v.wsUrl === "string" &&
    v.wsUrl.length > 0 &&
    typeof v.token === "string" &&
    v.token.length > 0
  );
}

/**
 * Negotiate the effective codecs against the server's mint offer. If our
 * preferred codec is not offered, fall back to the first offered codec. Used
 * to build the `hello` frame so we never advertise a codec the server did not
 * offer (which the server would reject as a negotiation mismatch).
 */
export function negotiateCodec(
  preferred: VoiceSessionCodec,
  offered: VoiceSessionCodec[] | undefined,
): VoiceSessionCodec | null {
  if (!offered || offered.length === 0) return null;
  if (offered.includes(preferred)) return preferred;
  return offered[0] ?? null;
}
