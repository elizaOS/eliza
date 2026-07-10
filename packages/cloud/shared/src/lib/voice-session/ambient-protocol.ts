/**
 * Ambient-mode WebSocket wire protocol (AMBIENT-MODE-DESIGN §1.2).
 *
 * Ambient is the SAME socket contract as conversation (protocol.ts), MINUS the
 * reply half (no downlink audio, no `llm_first_text`/`speaking_*`/`interrupted`),
 * PLUS: a mode-bearing hello, continuous-capture control frames
 * (`pause`/`resume`/`lease_renew`), and segment-commit / lease server events.
 *
 * This module owns ONLY the ambient-specific parse/serialize. It reuses the
 * conversation protocol's size ceilings and audio-frame validation verbatim
 * (there is one framing policy). It holds no auth, no provider state, no timers.
 *
 * Forbidden (design §11): no second transcript store, no downlink in ambient,
 * no text in any broadcast. The server events here carry canonical ids/ordinals
 * and interim/final transcript text to the OWNER over the owner's own socket
 * only — never to a fan-out (the pendant broadcast stays cursor-only elsewhere).
 */

import {
  MAX_CONTROL_FRAME_BYTES,
  VOICE_SESSION_PROTOCOL_VERSION,
  type ProtocolParseResult,
  type VoiceUplinkCodec,
} from "./protocol";

/** Server-side backstop: force a segment commit if a single Flux turn runs long. */
export const AMBIENT_DEFAULT_MAX_TURN_MS = 30_000;

// Ambient accepts pcm16 uplink ONLY in phase 1a (opus is a documented seam,
// mirrored from the conversation contract). Same restriction, one policy.
const AMBIENT_VALID_UPLINK_CODECS: readonly VoiceUplinkCodec[] = ["pcm16"];

// --- client -> server: ambient hello ------------------------------------

/**
 * Ambient hello. Distinct from the conversation hello by `mode:"ambient"`,
 * carrying the bound `pendantSessionId` and the plaintext `captureLeaseToken`
 * the mint issued. `downlinkCodec` is NOT present (ambient has no downlink); if
 * a client sends one it is ignored. The server verifies the JWT (which itself
 * carries the mode + pendantSessionId claims) AND that the lease token digest
 * matches the bound pendant session before any audio flows.
 */
export interface AmbientHelloFrame {
  t: "hello";
  mode: "ambient";
  token: string;
  protocol: number;
  pendantSessionId: string;
  captureLeaseToken: string;
  uplinkCodec: VoiceUplinkCodec;
  sampleRate: number;
}

export interface AmbientPauseFrame {
  t: "pause";
}
export interface AmbientResumeFrame {
  t: "resume";
}
/** Renew the capture lease over the socket (server holds the current token). */
export interface AmbientLeaseRenewFrame {
  t: "lease_renew";
}
export interface AmbientByeFrame {
  t: "bye";
}

export type AmbientClientControlFrame =
  | AmbientPauseFrame
  | AmbientResumeFrame
  | AmbientLeaseRenewFrame
  | AmbientByeFrame;

// --- server -> client: ambient events -----------------------------------

export type AmbientServerFrame =
  | { t: "ready"; sessionId: string; pendantSessionId: string; traceId: string }
  | { t: "stt_partial"; text: string; traceId: string }
  | {
      t: "stt_final";
      text: string;
      segmentId: string;
      ordinal: number;
      revision: number;
      traceId: string;
    }
  | { t: "segment_committed"; segmentId: string; ordinal: number; revision: number }
  | { t: "paused" }
  | { t: "resumed" }
  | { t: "lease_renewed"; leaseToken: string; leaseExpiresAt: string }
  | { t: "insight"; insightId: string; segmentIds: string[]; traceId: string }
  | { t: "usage"; sttMs: number; traceId: string }
  | { t: "error"; code: string; retryable: boolean };

// --- parsing ------------------------------------------------------------

function fail(code: string, message: string, retryable = false): ProtocolParseResult<never> {
  return { ok: false, code, message, retryable };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function byteLengthUtf8(value: string): number {
  return new TextEncoder().encode(value).length;
}

/**
 * True when a parsed control frame's `mode` field marks it as an ambient hello.
 * Used by the shared WS handler to branch to the ambient path at hello time
 * WITHOUT forking the handler: one handler reads `mode`, then dispatches.
 */
export function isAmbientHelloRaw(raw: unknown): boolean {
  if (typeof raw !== "string") return false;
  if (byteLengthUtf8(raw) > MAX_CONTROL_FRAME_BYTES) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  return isRecord(parsed) && parsed.t === "hello" && parsed.mode === "ambient";
}

/**
 * Parse an ambient hello. Enforces the conversation size ceiling, requires the
 * ambient fields, and pins pcm16 + 16 kHz. `downlinkCodec` (if present) is
 * ignored, not rejected, so a client that reuses the conversation hello shape
 * with `mode:"ambient"` still connects.
 */
export function parseAmbientHello(raw: unknown): ProtocolParseResult<AmbientHelloFrame> {
  if (typeof raw !== "string") {
    return fail("control_not_text", "control frame must be JSON text");
  }
  if (byteLengthUtf8(raw) > MAX_CONTROL_FRAME_BYTES) {
    return fail("control_too_large", "control frame exceeds size limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("control_invalid_json", "control frame is not valid JSON");
  }
  if (!isRecord(parsed) || parsed.t !== "hello" || parsed.mode !== "ambient") {
    return fail("hello_not_ambient", "expected an ambient hello frame");
  }
  const v = parsed;
  if (typeof v.token !== "string" || v.token.trim() === "") {
    return fail("hello_missing_token", "ambient hello is missing token");
  }
  if (v.protocol !== VOICE_SESSION_PROTOCOL_VERSION) {
    return fail("hello_bad_protocol", "unsupported protocol version");
  }
  if (typeof v.pendantSessionId !== "string" || v.pendantSessionId.trim() === "") {
    return fail("hello_missing_pendant_session", "ambient hello is missing pendantSessionId");
  }
  if (typeof v.captureLeaseToken !== "string" || v.captureLeaseToken.trim() === "") {
    return fail("hello_missing_lease", "ambient hello is missing captureLeaseToken");
  }
  const uplinkCodec = v.uplinkCodec;
  if (
    typeof uplinkCodec !== "string" ||
    !AMBIENT_VALID_UPLINK_CODECS.includes(uplinkCodec as VoiceUplinkCodec)
  ) {
    return fail("hello_bad_uplink_codec", "unsupported uplink codec");
  }
  if (typeof v.sampleRate !== "number" || v.sampleRate !== 16000) {
    return fail("hello_bad_sample_rate", "sampleRate must be 16000");
  }
  return {
    ok: true,
    value: {
      t: "hello",
      mode: "ambient",
      token: v.token,
      protocol: VOICE_SESSION_PROTOCOL_VERSION,
      pendantSessionId: v.pendantSessionId,
      captureLeaseToken: v.captureLeaseToken,
      uplinkCodec: uplinkCodec as VoiceUplinkCodec,
      sampleRate: v.sampleRate,
    },
  };
}

/**
 * Parse an ambient control frame received AFTER hello (`pause`/`resume`/
 * `lease_renew`/`bye`). A `barge_in` frame is accepted-and-ignored (ambient has
 * no downlink to interrupt); an unknown type is a surfaced, non-fatal error.
 */
export function parseAmbientControlFrame(
  raw: unknown,
): ProtocolParseResult<AmbientClientControlFrame | { t: "barge_in_ignored" }> {
  if (typeof raw !== "string") {
    return fail("control_not_text", "control frame must be JSON text");
  }
  if (byteLengthUtf8(raw) > MAX_CONTROL_FRAME_BYTES) {
    return fail("control_too_large", "control frame exceeds size limit");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fail("control_invalid_json", "control frame is not valid JSON");
  }
  if (!isRecord(parsed) || typeof parsed.t !== "string") {
    return fail("control_missing_type", "control frame is missing a string `t`");
  }
  switch (parsed.t) {
    case "pause":
      return { ok: true, value: { t: "pause" } };
    case "resume":
      return { ok: true, value: { t: "resume" } };
    case "lease_renew":
      return { ok: true, value: { t: "lease_renew" } };
    case "bye":
      return { ok: true, value: { t: "bye" } };
    case "barge_in":
      // Design §1.2: barge_in is not used in ambient; accept and ignore.
      return { ok: true, value: { t: "barge_in_ignored" } };
    case "hello":
      return fail("duplicate_hello", "a second hello is not permitted");
    default:
      return fail("control_unknown_type", `unsupported ambient control frame: ${parsed.t}`);
  }
}

export function serializeAmbientServerFrame(frame: AmbientServerFrame): string {
  return JSON.stringify(frame);
}
