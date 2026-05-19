// Binary frame layout:
//   bytes 0–3  : big-endian uint32 — JSON header length
//   bytes 4–N  : UTF-8 JSON header
//   bytes N+1… : raw binary payload (audio PCM/Opus, JPEG, etc.)
//
// Text frames are JSON control messages (no binary payload).

export type XRDeviceType = "quest3" | "xreal" | "simulator";

// ── Client → Server (text frames) ──────────────────────────────────────────

export type XRClientControl =
  | { type: "hello"; deviceType: XRDeviceType; sessionId: string }
  | { type: "ping" };

// ── Client → Server (binary frames) ────────────────────────────────────────

export interface XRAudioHeader {
  type: "audio";
  ts: number;
  sampleRate: number;
  /** "webm-opus" from MediaRecorder, "pcm-f32" from ScriptProcessor fallback */
  encoding: "webm-opus" | "pcm-f32";
}

export interface XRFrameHeader {
  type: "frame";
  ts: number;
  width: number;
  height: number;
  format: "jpeg" | "webp";
  pose?: {
    position: { x: number; y: number; z: number };
    orientation: { x: number; y: number; z: number; w: number };
  };
}

export type XRBinaryHeader = XRAudioHeader | XRFrameHeader;

// ── Server → Client (text frames) ──────────────────────────────────────────

export type XRServerControl =
  | { type: "ready"; sessionId: string }
  | { type: "transcript"; text: string; final: boolean }
  | { type: "agent_text"; text: string }
  | { type: "pong" };

// ── Server → Client (binary frames) ────────────────────────────────────────

export interface XRTTSAudioHeader {
  type: "tts_audio";
  sampleRate: number;
  channels: number;
  /** encoding of the outbound audio */
  encoding: "mp3" | "wav" | "pcm-f32";
}

// ── Framing helpers ─────────────────────────────────────────────────────────

export function encodeBinaryFrame(
  header: XRBinaryHeader | XRTTSAudioHeader,
  payload: Uint8Array | Buffer,
): Buffer {
  const headerJson = Buffer.from(JSON.stringify(header), "utf8");
  const lenBuf = Buffer.allocUnsafe(4);
  lenBuf.writeUInt32BE(headerJson.length, 0);
  return Buffer.concat([lenBuf, headerJson, payload]);
}

export function decodeBinaryFrame(data: Buffer): {
  header: XRBinaryHeader | XRTTSAudioHeader;
  payload: Buffer;
} {
  const headerLen = data.readUInt32BE(0);
  const headerJson = data.subarray(4, 4 + headerLen).toString("utf8");
  const header = JSON.parse(headerJson) as XRBinaryHeader | XRTTSAudioHeader;
  const payload = data.subarray(4 + headerLen);
  return { header, payload };
}
