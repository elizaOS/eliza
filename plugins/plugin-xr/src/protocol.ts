// Binary frame layout:
//   bytes 0–3  : big-endian uint32 — JSON header length
//   bytes 4–N  : UTF-8 JSON header
//   bytes N+1… : raw binary payload (audio PCM/Opus, JPEG, etc.)
//
// Text frames are JSON control messages (no binary payload).

export type XRDeviceType = "quest3" | "xreal" | "simulator";

// ── Client → Server (text frames) ──────────────────────────────────────────

/** View panel state reported back from the XR device */
export interface XRViewPanelState {
  viewId: string;
  active: boolean;
  width?: number;
  height?: number;
}

export type XRClientControl =
  | { type: "hello"; deviceType: XRDeviceType; sessionId: string }
  | { type: "ping" }
  | { type: "view_ready"; viewId: string }
  | { type: "view_closed"; viewId: string }
  | { type: "view_event"; viewId: string; event: string; payload?: unknown };

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

/** XR panel sizing options */
export interface XRPanelConfig {
  /** Panel width relative to default (0.5 = half, 2.0 = double) */
  scale?: number;
  /** Follow mode: billboard | fixed | follow */
  followMode?: "billboard" | "fixed" | "follow";
  /** Distance from camera in metres */
  distance?: number;
  /** Whether to show as full-overlay or floating panel */
  fullscreen?: boolean;
}

export type XRServerControl =
  | { type: "ready"; sessionId: string }
  | { type: "transcript"; text: string; final: boolean }
  | { type: "agent_text"; text: string }
  | { type: "pong" }
  // ── View commands ────────────────────────────────────────────────────────
  /** Open (or bring to front) a view by its registered view id */
  | {
      type: "view_open";
      viewId: string;
      agentBaseUrl: string;
      config?: XRPanelConfig;
    }
  /** Close a specific view panel */
  | { type: "view_close"; viewId: string }
  /** Switch the "active" (foreground) view */
  | { type: "view_switch"; viewId: string }
  /** Resize / reposition the active or named panel */
  | { type: "view_resize"; viewId?: string; config: XRPanelConfig }
  /** Send all available views to the device for the launcher */
  | {
      type: "views_catalog";
      views: Array<{
        id: string;
        label: string;
        icon?: string;
        description?: string;
      }>;
    };

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
