/** Normalize ws events across Node and Bun without losing the wire frame kind. */
import type { CartesiaInkWebSocket } from "@elizaos/host/voice/cartesia-ink";
import type { CartesiaWebSocketLike } from "@elizaos/host/voice/cartesia-sonic-tts";
import type { ServerWebSocketLike } from "@elizaos/host/voice/ws-handler";
import type WebSocket from "ws";
import type { RawData } from "ws";

type Events = {
  open: Event;
  message: MessageEvent;
  error: Event & { message: string; error: Error };
  close: CloseEvent;
};
type Listener = (event: Events[keyof Events]) => void;
type SocketListener = Parameters<WebSocket["on"]>[1];

function bytes(data: RawData | string): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return typeof data === "string"
    ? Buffer.from(data, "utf8")
    : Buffer.from(data);
}

/**
 * Bun's ws-compatible addEventListener can expose a text frame as Buffer. The
 * EventEmitter API retains isBinary; use that bit, never the payload's shape,
 * to distinguish control JSON from audio on either side of the voice session.
 */
export function adaptVoiceWebSocket(
  socket: WebSocket,
): CartesiaInkWebSocket & CartesiaWebSocketLike & ServerWebSocketLike {
  const listeners = new Map<Listener, Map<keyof Events, SocketListener>>();
  // error-policy:J6 DOM WebSocket errors are events, not unhandled exceptions.
  // Retain that behavior when an adapter removes its observers during a
  // cancelled handshake; active protocol observers still receive every error.
  socket.on("error", () => {});

  function addEventListener<K extends keyof Events>(
    type: K,
    listener: (event: Events[K]) => void,
  ): void {
    const erased = listener as Listener;
    let registrations = listeners.get(erased);
    if (!registrations) {
      registrations = new Map();
      listeners.set(erased, registrations);
    }
    if (registrations.has(type)) return;
    let handler: SocketListener;
    switch (type) {
      case "message":
        handler = (data: RawData, isBinary: boolean) => {
          const payload = bytes(data);
          // Unknown frame kind fails closed as binary instead of becoming JSON.
          erased(
            new MessageEvent("message", {
              data: isBinary === false ? payload.toString("utf8") : payload,
            }),
          );
        };
        break;
      case "close":
        handler = (code: number, reason: Buffer) => {
          erased(
            Object.assign(new Event("close"), {
              code,
              reason: bytes(reason).toString("utf8"),
              wasClean: code === 1000,
            }),
          );
        };
        break;
      case "error":
        handler = (error: Error) => {
          erased(
            Object.assign(new Event("error"), {
              error,
              message: error.message,
            }),
          );
        };
        break;
      default:
        handler = () => erased(new Event("open"));
    }
    registrations.set(type, handler);
    socket.on(type, handler);
  }
  function removeEventListener<K extends keyof Events>(
    type: K,
    listener: (event: Events[K]) => void,
  ): void {
    const erased = listener as Listener;
    const registrations = listeners.get(erased);
    const handler = registrations?.get(type);
    if (!handler) return;
    socket.off(type, handler);
    registrations?.delete(type);
    if (registrations?.size === 0) listeners.delete(erased);
  }
  return {
    get readyState() {
      return socket.readyState;
    },
    get binaryType() {
      return "arraybuffer";
    },
    set binaryType(_value: BinaryType) {
      socket.binaryType = "arraybuffer";
    },
    send(data: string | ArrayBuffer | ArrayBufferView) {
      socket.send(data);
    },
    close(code?: number, reason?: string) {
      socket.close(code, reason);
    },
    addEventListener,
    removeEventListener,
  };
}
