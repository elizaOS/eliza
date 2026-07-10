/**
 * Adapt the `ws` npm WebSocket to the exact factory interfaces the MERGED
 * provider adapters expect. We use `ws` (not the runtime-native WebSocket)
 * because Bun's native `WebSocket` does NOT reliably forward custom request
 * headers, and both providers authenticate via a request header
 * (`Authorization: Token ...` for Deepgram, `X-API-Key` for Cartesia). Proven
 * empirically in this harness: native WebSocket => 1002 "Expected 101 status
 * code" (auth header dropped); `ws` with headers => clean 101 upgrade.
 *
 * These factories construct REAL sockets to REAL provider endpoints. No mock
 * socket exists in the provider legs.
 *
 * ------------------------------------------------------------------------
 * ADAPTER DEFECT SURFACED BY THIS HARNESS (deepgram-flux.ts, merged #15950):
 *   buildDeepgramFluxListenUrl() unconditionally appends `channels=1` to the
 *   /v2/listen query string. The LIVE Deepgram Flux endpoint REJECTS that with
 *     {"err_code":"INVALID_QUERY_PARAMETER",
 *      "err_msg":"Unknown query parameters: channels"}
 *   causing a 1002 close BEFORE any audio flows. Flux is mono-only and infers a
 *   single channel from `encoding=linear16`; the `channels` param is not part of
 *   the /v2/listen contract. This blocks the real server too, not just the
 *   harness. The harness strips `channels` at the transport boundary so the
 *   full pipeline can be proven end-to-end today, and records the strip loudly.
 *   FIX NEEDED in the adapter: drop the `channels` search param from
 *   buildDeepgramFluxListenUrl (verified: removing it => clean 101 upgrade).
 * ------------------------------------------------------------------------
 */

import WebSocketImpl from "ws";
import type {
  DeepgramFluxWebSocket,
  DeepgramFluxWebSocketFactory,
  DeepgramFluxTransportRequest,
} from "@harness-adapters/deepgram-flux.ts";
import type {
  CartesiaWebSocketFactory,
  CartesiaWebSocketLike,
  CartesiaWebSocketFactoryOptions,
} from "@harness-adapters/cartesia-sonic-tts.ts";

export interface FactoryHooks {
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

/**
 * `ws` sockets expose Node EventEmitter (`on`) rather than
 * `addEventListener`. Wrap so the adapters' `addEventListener`/
 * `removeEventListener` DOM-shaped API works unchanged.
 */
function wrapDom(socket: WebSocketImpl): DeepgramFluxWebSocket & CartesiaWebSocketLike {
  const listenerMap = new WeakMap<(e: unknown) => void, (...a: unknown[]) => void>();

  const toDomEvent = (type: string, ...args: unknown[]): unknown => {
    switch (type) {
      case "open":
        return { type: "open" };
      case "message": {
        const raw = args[0];
        // Both Deepgram Flux and Cartesia send JSON TEXT frames (Cartesia audio is
        // base64 inside JSON). The adapters require `typeof event.data === string`.
        // `ws` may hand us a Buffer, an ArrayBuffer (when binaryType=arraybuffer),
        // an array of Buffers (fragments), or a string. Normalize every non-string
        // text frame to a utf8 string so the adapter parser never sees a non-string.
        let data: unknown = raw;
        if (typeof raw !== "string") {
          if (Buffer.isBuffer(raw)) data = raw.toString("utf8");
          else if (raw instanceof ArrayBuffer) data = Buffer.from(raw).toString("utf8");
          else if (ArrayBuffer.isView(raw))
            data = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString("utf8");
          else if (Array.isArray(raw)) data = Buffer.concat(raw).toString("utf8");
        }
        return { type: "message", data };
      }
      case "error": {
        const err = args[0] as Error;
        return { type: "error", message: err?.message, error: err };
      }
      case "close": {
        const code = args[0] as number;
        const reason = args[1];
        return {
          type: "close",
          code,
          reason: Buffer.isBuffer(reason) ? reason.toString("utf8") : String(reason ?? ""),
          wasClean: code === 1000,
        };
      }
      default:
        return { type };
    }
  };

  const wrapped = {
    get readyState() {
      return socket.readyState;
    },
    set binaryType(v: string) {
      // ws uses "nodebuffer" | "arraybuffer" | "fragments"
      (socket as unknown as { binaryType: string }).binaryType =
        v === "arraybuffer" ? "arraybuffer" : "nodebuffer";
    },
    get binaryType() {
      return (socket as unknown as { binaryType: string }).binaryType;
    },
    send(data: string | ArrayBuffer | ArrayBufferView) {
      socket.send(data as never);
    },
    close(code?: number, reason?: string) {
      socket.close(code, reason);
    },
    addEventListener(type: string, listener: (e: unknown) => void) {
      const handler = (...args: unknown[]) => listener(toDomEvent(type, ...args));
      listenerMap.set(listener, handler);
      socket.on(type, handler as never);
    },
    removeEventListener(type: string, listener: (e: unknown) => void) {
      const handler = listenerMap.get(listener);
      if (handler) socket.off(type, handler as never);
    },
  };
  return wrapped as unknown as DeepgramFluxWebSocket & CartesiaWebSocketLike;
}

export function makeDeepgramFactory(hooks?: FactoryHooks): DeepgramFluxWebSocketFactory {
  return (request: DeepgramFluxTransportRequest): DeepgramFluxWebSocket => {
    // Strip the unsupported `channels` param (see defect note above).
    const url = new URL(request.url);
    if (url.searchParams.has("channels")) {
      url.searchParams.delete("channels");
      hooks?.log?.("deepgram-flux: stripped unsupported 'channels' query param (adapter defect #15950)", {
        note: "Flux /v2/listen rejects channels; harness strips it to proceed",
      });
    }
    const socket = new WebSocketImpl(url.toString(), {
      headers: request.headers,
    });
    return wrapDom(socket);
  };
}

export function makeCartesiaFactory(_hooks?: FactoryHooks): CartesiaWebSocketFactory {
  return (url: string, options: CartesiaWebSocketFactoryOptions): CartesiaWebSocketLike => {
    const socket = new WebSocketImpl(url, { headers: options.headers });
    return wrapDom(socket);
  };
}
