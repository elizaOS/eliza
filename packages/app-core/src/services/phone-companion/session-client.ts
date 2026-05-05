import { logger } from "./logger";

/**
 * Remote session WebSocket client + touch-to-input translator.
 *
 * The companion opens a single WebSocket to the session ingress
 * (`wss://<ingress>/input`) and relays serialized input events. The host-side
 * session bridge (T9a data plane) forwards those events into the noVNC /
 * input-channel pipeline on the paired Mac.
 *
 * This module is pure — no React, no Capacitor. Makes it directly unit-testable
 * under jsdom/node.
 */

export type InputButton = "left" | "right" | "middle";

export type InputEvent =
  | { type: "mouse-move"; x: number; y: number }
  | { type: "mouse-down"; x: number; y: number; button: InputButton }
  | { type: "mouse-up"; x: number; y: number; button: InputButton }
  | { type: "mouse-click"; x: number; y: number; button: InputButton }
  | {
      type: "mouse-drag";
      fromX: number;
      fromY: number;
      toX: number;
      toY: number;
    };

export type SessionState = "idle" | "connecting" | "open" | "closed";

export interface TouchSample {
  /** Pointer X in VNC-viewport pixel coordinates. */
  x: number;
  /** Pointer Y in VNC-viewport pixel coordinates. */
  y: number;
  /** Milliseconds since epoch (or any monotonic reference). */
  t: number;
  /** Distinct finger ID. 0 = primary touch, 1 = second finger, etc. */
  pointerId: number;
}

export interface TouchGesture {
  /**
   * Per-pointer samples, in time order. `samples[0]` is always the primary
   * pointer (`pointerId: 0`). Multi-finger taps have one sample per pointer.
   */
  pointers: readonly (readonly TouchSample[])[];
  /** true if the gesture ended with all fingers lifted. */
  ended: boolean;
}

export interface TouchToInputOptions {
  /**
   * Maximum movement in CSS pixels for a sample sequence to still count as a
   * tap (vs a pan). Default 6px matches iOS Human Interface Guidelines for
   * tap slop.
   */
  tapSlopPx?: number;
  /**
   * Duration in ms above which a single-finger hold becomes a long-press
   * (right click). Default 500ms.
   */
  longPressMs?: number;
}

const DEFAULT_TAP_SLOP_PX = 6;
const DEFAULT_LONG_PRESS_MS = 500;

interface SessionEventMap {
  state: SessionState;
  error: Error;
  message: unknown;
}

type Listener<T> = (value: T) => void;

export class SessionClient {
  private socket: WebSocket | null = null;
  private state: SessionState = "idle";
  private readonly listeners: {
    [K in keyof SessionEventMap]: Set<Listener<SessionEventMap[K]>>;
  } = {
    state: new Set(),
    error: new Set(),
    message: new Set(),
  };

  constructor(
    private readonly webSocketFactory: (url: string) => WebSocket = (url) =>
      new WebSocket(url),
  ) {}

  getState(): SessionState {
    return this.state;
  }

  connect(ingressUrl: string, sessionToken: string): void {
    if (this.state !== "idle" && this.state !== "closed") {
      logger.warn("[SessionClient] connect ignored; already connected", {
        state: this.state,
      });
      return;
    }
    const url = appendToken(ingressUrl, sessionToken);
    logger.info("[SessionClient] connect", {
      urlHost: safeHost(url),
    });
    this.setState("connecting");
    const socket = this.webSocketFactory(url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      logger.info("[SessionClient] open", {});
      this.setState("open");
    });
    socket.addEventListener("close", (event: CloseEvent) => {
      if (this.socket !== socket) return;
      logger.info("[SessionClient] close", {
        code: event.code,
        clean: event.wasClean,
      });
      this.setState("closed");
    });
    socket.addEventListener("error", () => {
      if (this.socket !== socket) return;
      const err = new Error("SessionClient WebSocket error");
      logger.error("[SessionClient] error", { message: err.message });
      for (const listener of this.listeners.error) listener(err);
    });
    socket.addEventListener("message", (event: MessageEvent) => {
      if (this.socket !== socket) return;
      for (const listener of this.listeners.message) listener(event.data);
    });
  }

  sendInput(event: InputEvent): void {
    const socket = this.socket;
    if (socket === null || this.state !== "open") {
      logger.warn("[SessionClient] sendInput dropped; socket not open", {
        state: this.state,
        type: event.type,
      });
      return;
    }
    socket.send(JSON.stringify(event));
  }

  close(): void {
    if (this.socket !== null) {
      logger.info("[SessionClient] close requested", {});
      this.socket.close();
      this.socket = null;
    }
    this.setState("closed");
  }

  on<K extends keyof SessionEventMap>(
    event: K,
    handler: Listener<SessionEventMap[K]>,
  ): () => void {
    this.listeners[event].add(handler);
    return () => {
      this.listeners[event].delete(handler);
    };
  }

  private setState(next: SessionState): void {
    if (this.state === next) return;
    this.state = next;
    for (const listener of this.listeners.state) listener(next);
  }
}

function appendToken(ingressUrl: string, token: string): string {
  let parsed: URL;
  try {
    parsed = new URL(ingressUrl);
  } catch {
    throw new Error("SessionClient: ingress URL is not a valid absolute URL");
  }
  parsed.searchParams.set("token", token);
  return parsed.toString();
}

function safeHost(url: string): string {
  const match = /^wss?:\/\/([^/]+)/.exec(url);
  return match !== null ? match[1] : "unknown";
}

/**
 * Translate a completed touch gesture into a sequence of input events for
 * the remote host. Pure function.
 *
 * Rules (matches T9c spec):
 *   - single-finger tap (<= tapSlop, < longPress)          → left click
 *   - single-finger long-press (>= longPressMs, <= slop)   → right click
 *   - two-finger tap (2 simultaneous pointers, no drag)    → middle click
 *   - single-finger pan (> tapSlop)                        → mouse drag
 */
export function touchToInput(
  gesture: TouchGesture,
  options: TouchToInputOptions = {},
): InputEvent[] {
  if (!gesture.ended) return [];
  const tapSlop = options.tapSlopPx ?? DEFAULT_TAP_SLOP_PX;
  const longPress = options.longPressMs ?? DEFAULT_LONG_PRESS_MS;

  const pointers = gesture.pointers.filter((samples) => samples.length > 0);
  if (pointers.length === 0) return [];

  if (pointers.length === 2) {
    const primary = pointers[0];
    const secondary = pointers[1];
    if (isTap(primary, tapSlop) && isTap(secondary, tapSlop)) {
      const pos = lastSample(primary);
      return [{ type: "mouse-click", x: pos.x, y: pos.y, button: "middle" }];
    }
    return [];
  }

  if (pointers.length !== 1) return [];
  const samples = pointers[0];
  const first = samples[0];
  const last = lastSample(samples);
  const displacement = distance(first.x, first.y, last.x, last.y);
  const duration = last.t - first.t;

  if (displacement <= tapSlop) {
    if (duration >= longPress) {
      return [{ type: "mouse-click", x: last.x, y: last.y, button: "right" }];
    }
    return [{ type: "mouse-click", x: last.x, y: last.y, button: "left" }];
  }

  return [
    {
      type: "mouse-drag",
      fromX: first.x,
      fromY: first.y,
      toX: last.x,
      toY: last.y,
    },
  ];
}

function isTap(samples: readonly TouchSample[], tapSlopPx: number): boolean {
  if (samples.length === 0) return false;
  const first = samples[0];
  let maxDist = 0;
  for (const s of samples) {
    const d = distance(first.x, first.y, s.x, s.y);
    if (d > maxDist) maxDist = d;
  }
  return maxDist <= tapSlopPx;
}

function lastSample(samples: readonly TouchSample[]): TouchSample {
  const s = samples[samples.length - 1];
  if (!s) throw new Error("lastSample called with empty array");
  return s;
}

function distance(x1: number, y1: number, x2: number, y2: number): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Parse a pairing QR code payload. The QR contains base64(JSON).
 * Throws on malformed input — the caller (UI) shows a user-facing error.
 */
export interface PairingPayload {
  agentId: string;
  pairingCode: string;
  ingressUrl: string;
  sessionToken: string;
}

export function decodePairingPayload(raw: string): PairingPayload {
  const decoded = decodeBase64(raw.trim());
  const parsed: unknown = JSON.parse(decoded);
  if (!isRecord(parsed)) {
    throw new Error("PairingPayload decode: not an object");
  }
  const { agentId, pairingCode, ingressUrl, sessionToken } = parsed;
  if (
    typeof agentId !== "string" ||
    typeof pairingCode !== "string" ||
    typeof ingressUrl !== "string" ||
    typeof sessionToken !== "string"
  ) {
    throw new Error(
      "PairingPayload decode: missing or non-string required field",
    );
  }
  return { agentId, pairingCode, ingressUrl, sessionToken };
}

function decodeBase64(input: string): string {
  if (typeof atob === "function") return atob(input);
  // Node fallback for tests running without jsdom shims.
  const nodeBuffer = (
    globalThis as {
      Buffer?: {
        from(input: string, enc: string): { toString(enc: string): string };
      };
    }
  ).Buffer;
  if (nodeBuffer !== undefined) {
    return nodeBuffer.from(input, "base64").toString("utf8");
  }
  throw new Error("decodeBase64: no atob or Buffer available");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
