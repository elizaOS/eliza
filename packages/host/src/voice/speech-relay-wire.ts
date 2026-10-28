/** Speech-only v1: control JSON <= 8192 UTF-8 bytes; uplink binary is 16kHz mono PCM16.
 * Downlink audio is binary: [version=1,u8 context-id length,ASCII context-id,PCM16].
 * No model, agent, conversation callback, provider credential or arbitrary URL is accepted.
 */
import {
  parseSpeechRelayControl,
  type SpeechRelayControl,
  type SpeechRelayEvent,
} from "./speech-relay-session";
export const SPEECH_RELAY_WIRE_VERSION = 1;
export const SPEECH_RELAY_ROUTES = Object.freeze({
  consent: "/api/v1/voice/speech/consent",
  mint: "/api/v1/voice/speech/session",
  ws: "/api/v1/voice/speech/ws",
  revoke: (sessionId: string) =>
    `/api/v1/voice/speech/session/${encodeURIComponent(sessionId)}/revoke`,
});
export interface SpeechRelayMint {
  sessionId: string;
  token: string;
  expiresAt: string;
  wsUrl: string;
  version: 1;
}
export interface SpeechRelayConsent {
  consentNonce: string;
  expiresAt: string;
}

export type SpeechRelayHello = {
  t: "hello";
  token: string;
  errorReasons?: true;
};
export type SpeechRelayServerControl =
  | {
      t: "ready";
      version: 1;
      sampleRate: 16000;
      channels: 1;
      expiresAt: string;
    }
  | Exclude<SpeechRelayEvent, { t: "audio" }>
  | {
      t: "error";
      code: "unauthorized" | "protocol" | "unavailable" | "closed";
      reason?: "insufficient_credits";
    };
export function parseSpeechRelayJson(
  raw: string,
): SpeechRelayControl | SpeechRelayHello {
  if (new TextEncoder().encode(raw).byteLength > 8192)
    throw Error("Speech control is too large");
  const value: unknown = JSON.parse(raw);
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    "t" in value &&
    value.t === "hello"
  ) {
    const hello = value as Record<string, unknown>;
    if (
      Object.keys(hello).length !==
        (Object.hasOwn(hello, "errorReasons") ? 3 : 2) ||
      Object.keys(hello).some(
        (key) => !["t", "token", "errorReasons"].includes(key),
      ) ||
      (Object.hasOwn(hello, "errorReasons") && hello.errorReasons !== true) ||
      typeof hello.token !== "string" ||
      hello.token.length > 6144 ||
      !hello.token
    )
      throw Error("Invalid speech hello");
    return {
      t: "hello",
      token: hello.token,
      ...(hello.errorReasons === true ? { errorReasons: true as const } : {}),
    };
  }
  return parseSpeechRelayControl(value);
}
export function encodeSpeechRelayAudio(
  id: string,
  pcm: Uint8Array,
): Uint8Array {
  if (
    !/^[A-Za-z0-9_-]{1,64}$/.test(id) ||
    !pcm.byteLength ||
    pcm.byteLength % 2 ||
    pcm.byteLength > 65536
  )
    throw Error("Invalid speech audio");
  const name = new TextEncoder().encode(id),
    out = new Uint8Array(2 + name.length + pcm.length);
  out[0] = 1;
  out[1] = name.length;
  out.set(name, 2);
  out.set(pcm, 2 + name.length);
  return out;
}
export function decodeSpeechRelayAudio(frame: Uint8Array): {
  id: string;
  pcm: Uint8Array;
} {
  if (
    frame.length < 3 ||
    frame[0] !== 1 ||
    frame[1] < 1 ||
    frame[1] > 64 ||
    frame.length < 2 + frame[1]
  )
    throw Error("Invalid speech audio frame");
  const id = new TextDecoder("utf-8", { fatal: true }).decode(
      frame.subarray(2, 2 + frame[1]),
    ),
    pcm = frame.subarray(2 + frame[1]);
  if (
    !/^[A-Za-z0-9_-]{1,64}$/.test(id) ||
    !pcm.length ||
    pcm.length % 2 ||
    pcm.length > 65536
  )
    throw Error("Invalid speech audio frame");
  return { id, pcm };
}
