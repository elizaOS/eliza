/**
 * Outbound provider WebSocket factories for the realtime voice path.
 *
 * These build the sockets the Cartesia Ink STT, Cartesia Sonic TTS, and optional
 * Fish Audio adapters drive. Bun's native `WebSocket` drops custom request
 * headers, so provider auth never arrives. Cloudflare Workers preserves those
 * headers through `fetch(url, { headers, method: "GET" }).webSocket`; this
 * module adapts that platform socket to each provider's minimal contract.
 *
 * On a non-Workers runtime without a header-preserving native WebSocket, the
 * caller must inject a factory backed by the `ws` package (see the route). We do
 * NOT silently fall back to a header-dropping socket — provider auth failing
 * closed is correct.
 */

import type {
  CartesiaWebSocketFactory,
  CartesiaWebSocketLike,
} from "@elizaos/cloud-shared/lib/services/cartesia-sonic-tts";
import type {
  FishAudioWebSocketFactory,
  FishAudioWebSocketLike,
} from "@elizaos/cloud-shared/lib/services/fish-audio-tts";
import type {
  CartesiaInkWebSocket,
  CartesiaInkWebSocketFactory,
} from "../../stt/providers/cartesia-ink";

interface WorkerUpgradeSocket {
  accept?(): void;
  retirementState?():
    | "pending"
    | "not_dispatched"
    | "transport_closed"
    | "unknown";
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: unknown) => void): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
}

/**
 * True when the runtime exposes the Workers outbound-WS upgrade path
 * (`fetch(...).webSocket`). On plain Node/Bun this is false and the caller must
 * inject a header-preserving factory.
 */
export function isWorkerOutboundWsAvailable(): boolean {
  return typeof globalThis !== "undefined" && "WebSocketPair" in globalThis;
}

/**
 * Cartesia Ink factory using the Workers header-preserving outbound upgrade.
 */
export function createWorkerCartesiaInkFactory(): CartesiaInkWebSocketFactory {
  return (request) => {
    return openWorkerSocket(
      request.url,
      request.headers,
    ) as unknown as CartesiaInkWebSocket;
  };
}

/** Cartesia factory using the Workers header-preserving outbound upgrade. */
export function createWorkerCartesiaFactory(): CartesiaWebSocketFactory {
  return (url, options) => {
    return openWorkerSocket(
      url,
      options.headers,
    ) as unknown as CartesiaWebSocketLike;
  };
}

/** Fish Audio factory using the Workers header-preserving outbound upgrade. */
export function createWorkerFishAudioFactory(): FishAudioWebSocketFactory {
  return (url, options) => {
    return openWorkerSocket(
      url,
      options.headers,
    ) as unknown as FishAudioWebSocketLike;
  };
}

function openWorkerSocket(
  url: string,
  headers: Record<string, string>,
): WorkerUpgradeSocket {
  // Deferred socket: the adapters attach listeners synchronously and expect a
  // socket object immediately, so we return a proxy that buffers until the
  // outbound upgrade resolves.
  const proxy = new DeferredWorkerSocket();
  void (async () => {
    try {
      // The Workers outbound WS upgrade goes through `fetch()` with an
      // HTTP(S) request URL, not a `ws(s):` URL. Providers hand us `wss://`, so
      // map the scheme to `https://` (and `ws://` -> `http://`) for the fetch.
      const httpUrl = url.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
      const response = await fetch(httpUrl, {
        method: "GET",
        headers: { ...headers, Upgrade: "websocket" },
        signal: proxy.signal,
      });
      const ws = (response as unknown as { webSocket?: WorkerUpgradeSocket })
        .webSocket;
      if (!ws) {
        await response.body?.cancel();
        proxy.failOpen(
          new Error(`outbound WS upgrade failed: HTTP ${response.status}`),
        );
        return;
      }
      proxy.bind(ws);
    } catch (error) {
      // error-policy:J1 boundary translation — the async Workers upgrade is the
      // transport boundary; failures surface via the socket's error/close
      // listeners, which the adapters observe.
      proxy.failOpen(error);
    } finally {
      proxy.markUpgradeSettled();
    }
  })();
  return proxy;
}

/**
 * Buffers listener registration + sends until the real outbound socket binds.
 * Keeps the merged adapters' synchronous construction contract intact on the
 * async Workers upgrade.
 */
class DeferredWorkerSocket implements WorkerUpgradeSocket {
  private readonly upgradeAbort = new AbortController();
  readonly signal = this.upgradeAbort.signal;
  // Report OPEN immediately. The adapters gate `send` on `readyState === 1`,
  // but this proxy BUFFERS every send until the real outbound socket binds, so
  // reporting open is safe and prevents the adapter from dropping the first
  // (admission-released) audio frames while the Workers upgrade is still in
  // flight. Nothing is actually transmitted until `bind()` flushes the buffer.
  readyState = 1;
  binaryType = "arraybuffer";
  private real: WorkerUpgradeSocket | null = null;
  private upgradeFinished = false;
  private observedRealClose = false;
  private observedCleanClose = false;
  private dispatchAttempted = false;

  markUpgradeSettled(): void {
    this.upgradeFinished = true;
  }

  retirementState():
    | "pending"
    | "not_dispatched"
    | "transport_closed"
    | "unknown" {
    if (this.real)
      return this.observedCleanClose
        ? this.dispatchAttempted
          ? "transport_closed"
          : "not_dispatched"
        : this.observedRealClose
          ? "unknown"
          : "pending";
    return this.upgradeFinished ? "unknown" : "pending";
  }
  private readonly pendingSends: (string | ArrayBuffer | ArrayBufferView)[] =
    [];
  private readonly listeners: Array<[string, (event: unknown) => void]> = [];
  private closedEarly: { code?: number; reason?: string } | null = null;

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (this.closedEarly || this.observedRealClose) return;
    if (this.real) {
      this.dispatchAttempted = true;
      this.real.send(data);
      return;
    }
    // Never buffer sends once closed early — they must not reach the provider.
    if (this.closedEarly) return;
    this.pendingSends.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedEarly = { code, reason };
    this.pendingSends.length = 0;
    if (this.real) {
      this.real.close(code, reason);
      return;
    }
    this.readyState = 2;
    this.upgradeAbort.abort();
    // A late bind remains tracked and may only close; queued data stays dropped.
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (this.real) {
      this.real.addEventListener(type, listener);
      return;
    }
    this.listeners.push([type, listener]);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    if (this.real) {
      this.real.removeEventListener(type, listener);
      return;
    }
    const idx = this.listeners.findIndex(
      ([t, l]) => t === type && l === listener,
    );
    if (idx !== -1) this.listeners.splice(idx, 1);
  }

  bind(real: WorkerUpgradeSocket): void {
    this.real = real;
    real.addEventListener("close", (event) => {
      this.observedRealClose = true;
      const close = event as { code?: number; wasClean?: boolean };
      this.observedCleanClose = close.code === 1000 && close.wasClean === true;
      this.readyState = 3;
    });
    // Observe a late provider close even when an earlier cancellation won.
    for (const [type, listener] of this.listeners)
      real.addEventListener(type, listener);
    real.accept?.();

    // If the session was severed/closed BEFORE the outbound upgrade completed
    // (the slow-upgrade race this proxy exists for), we must NOT flush buffered
    // audio to the provider — doing so would send audio after teardown and
    // break the revoke-to-silence / no-post-close guarantee. Drop the buffer
    // and close immediately.
    if (this.closedEarly) {
      this.pendingSends.length = 0;
      this.readyState = 3;
      real.close(this.closedEarly.code, this.closedEarly.reason);
      return;
    }

    if (this.observedRealClose) {
      this.pendingSends.length = 0;
      return;
    }
    this.readyState = 1;
    for (const data of this.pendingSends) {
      this.dispatchAttempted = true;
      real.send(data);
    }
    this.pendingSends.length = 0;
    // Synthesize an `open` for adapters that expect it after binding.
    for (const [type, listener] of this.listeners) {
      if (type === "open") listener({});
    }
  }

  failOpen(error: unknown): void {
    // Neither local cancellation nor a generic failed HTTP upgrade proves
    // absence of remote provider allocation. Keep the issued dial unknown
    // unless an actual bound provider socket supplies accepted close evidence.
    if (this.real && !this.observedRealClose) {
      this.closedEarly ??= { code: 1000, reason: "upgrade failed" };
      this.readyState = 2;
      try {
        this.real.close(1000, "upgrade failed");
      } catch {
        /* Retain unknown until an actual close. */
      }
    } else this.readyState = 3;
    for (const [type, listener] of this.listeners) {
      if (type === "error") listener({ error });
      if (type === "close")
        listener({ code: 1006, reason: "upgrade failed", wasClean: false });
    }
  }
}
