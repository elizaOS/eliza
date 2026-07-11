/**
 * Cartesia Sonic TTS synthesis for the cloud voice route: drives the shared
 * `CartesiaSonicTtsAdapter` over a Cloudflare-Workers WebSocket and returns a
 * finished WAV for codec-less clients (the LP3 has no MP3 decoder).
 *
 * Why this exists: the adapter (`@elizaos/cloud-shared`) owns only Cartesia's
 * WebSocket protocol and is transport-injected for tests; it needs a real
 * WebSocket factory. Workers open outbound sockets via a `fetch` upgrade
 * (async), but the adapter's factory contract is synchronous, so the factory
 * here returns a listener-queuing wrapper that connects lazily and fires
 * `open` once the upgrade completes. Cartesia streams raw `pcm_s16le` frames
 * (~200 ms to first audio, ~0.5 s total for a short reply, vs ~3 s for a
 * buffered ElevenLabs WAV); this module buffers those frames and wraps them in
 * a WAV header. A future streaming variant can forward frames incrementally.
 */
import {
  CartesiaSonicTtsAdapter,
  type CartesiaWebSocketFactory,
  type CartesiaWebSocketLike,
} from "../../../../shared/src/lib/services/cartesia-sonic-tts";
import { pcm16ToWav } from "../../../../shared/src/lib/services/pcm16-wav";

/**
 * Build a {@link CartesiaWebSocketFactory} backed by the Cloudflare Workers
 * outbound-WebSocket upgrade. The adapter calls this synchronously and then
 * registers its own listeners; the returned wrapper buffers those listeners,
 * performs the async `fetch(..., { Upgrade: "websocket" })` connect, and
 * replays `open`/`message`/`close`/`error` from the accepted socket. The
 * adapter already queues `sendPhrase` until `open`, so a lazy connect is safe.
 */
export function makeWorkersCartesiaWebSocketFactory(): CartesiaWebSocketFactory {
  return (url, options) => {
    const openListeners: Array<() => void> = [];
    const messageListeners: Array<(event: { readonly data: unknown }) => void> =
      [];
    const errorListeners: Array<
      (event: { readonly message?: string; readonly error?: unknown }) => void
    > = [];
    const closeListeners: Array<
      (event: { readonly code?: number; readonly reason?: string }) => void
    > = [];

    let socket: WebSocket | null = null;
    // 0 CONNECTING, 1 OPEN, 2 CLOSING, 3 CLOSED — mirrors the WebSocket enum.
    let readyState = 0;

    // Workers dial the upgrade over https/http, not ws/wss.
    const httpUrl = url.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");

    (async () => {
      try {
        const response = await fetch(httpUrl, {
          headers: { ...options.headers, Upgrade: "websocket" },
        });
        const ws = (response as unknown as { webSocket?: WebSocket }).webSocket;
        if (!ws) {
          throw new Error(
            `Cartesia WebSocket upgrade failed (status ${response.status})`,
          );
        }
        ws.accept();
        socket = ws;
        readyState = 1;
        ws.addEventListener("message", (event: MessageEvent) => {
          for (const l of messageListeners) l({ data: event.data });
        });
        ws.addEventListener("close", (event: CloseEvent) => {
          readyState = 3;
          for (const l of closeListeners)
            l({ code: event.code, reason: event.reason });
        });
        ws.addEventListener("error", (event: Event) => {
          for (const l of errorListeners)
            l({ message: (event as { message?: string }).message });
        });
        for (const l of openListeners) l();
      } catch (error) {
        readyState = 3;
        const message = error instanceof Error ? error.message : String(error);
        for (const l of errorListeners) l({ message, error });
      }
    })();

    const wrapper: CartesiaWebSocketLike = {
      get readyState() {
        return readyState;
      },
      send(data: string) {
        socket?.send(data);
      },
      close(code?: number, reason?: string) {
        readyState = 2;
        socket?.close(code, reason);
      },
      addEventListener(type: string, listener: unknown) {
        if (type === "open") openListeners.push(listener as () => void);
        else if (type === "message")
          messageListeners.push(
            listener as (event: { readonly data: unknown }) => void,
          );
        else if (type === "error")
          errorListeners.push(
            listener as (event: {
              readonly message?: string;
              readonly error?: unknown;
            }) => void,
          );
        else if (type === "close")
          closeListeners.push(
            listener as (event: {
              readonly code?: number;
              readonly reason?: string;
            }) => void,
          );
      },
    } as CartesiaWebSocketLike;
    return wrapper;
  };
}

export interface CartesiaWavResult {
  readonly wav: Uint8Array;
  readonly pcmBytes: number;
  readonly firstAudioMs: number;
  readonly totalMs: number;
}

/** Wall-clock ceiling for one synthesis. Measured completions run ~0.6-0.9s;
 * this exists so a half-open socket (no `done`, no `close`) cannot pin the
 * request open — on expiry the stream is cancelled and the caller falls back
 * to ElevenLabs. */
const DEFAULT_SYNTHESIS_TIMEOUT_MS = 15_000;

/**
 * Synthesize `text` with Cartesia Sonic and return a finished 16-bit PCM WAV.
 * Buffers all audio frames (a short assistant reply is a few dozen KB) up to
 * `maxPcmBytes`, then wraps them in a WAV header. Throws — so the caller falls
 * back to ElevenLabs and never serves broken speech — on provider error, a
 * socket that closes before any audio, audio exceeding `maxPcmBytes`
 * (truncated speech must not be returned as success), or the synthesis
 * deadline expiring.
 */
export async function synthesizeCartesiaWav(args: {
  apiKey: string;
  voiceId: string;
  text: string;
  sampleRate: number;
  maxPcmBytes: number;
  webSocketFactory?: CartesiaWebSocketFactory;
  timeoutMs?: number;
}): Promise<CartesiaWavResult> {
  const adapter = new CartesiaSonicTtsAdapter({
    apiKey: args.apiKey,
    voiceId: args.voiceId,
    websocketFactory:
      args.webSocketFactory ?? makeWorkersCartesiaWebSocketFactory(),
    sampleRate: args.sampleRate,
    encoding: "pcm_s16le",
  });

  const frames: Uint8Array[] = [];
  let pcmBytes = 0;
  let firstAudioMs = -1;
  let overflowed = false;
  let providerError: Error | null = null;
  let signalProviderError: (() => void) | undefined;
  const providerErrorSignal = new Promise<void>((resolve) => {
    signalProviderError = resolve;
  });
  const started = Date.now();

  const stream = adapter.createStream(
    { contextId: "cloud-tts" },
    {
      onFirstAudio: () => {
        if (firstAudioMs < 0) firstAudioMs = Date.now() - started;
      },
      onAudioFrame: (event) => {
        if (overflowed) return;
        if (pcmBytes + event.bytes.byteLength > args.maxPcmBytes) {
          // Fail loud, not truncated: drop the buffered frames immediately
          // (free the memory) and cancel the stream — a partial WAV played to
          // the user is worse than the ElevenLabs fallback.
          overflowed = true;
          frames.length = 0;
          stream.cancel("pcm byte cap exceeded");
          return;
        }
        frames.push(event.bytes);
        pcmBytes += event.bytes.byteLength;
      },
      onProviderError: (event) => {
        providerError = new Error(
          `Cartesia provider error: ${event.title}: ${event.message}`,
        );
        signalProviderError?.();
      },
    },
  );

  stream.sendPhrase({ text: args.text, continueContext: false, flush: true });

  const timeoutMs = args.timeoutMs ?? DEFAULT_SYNTHESIS_TIMEOUT_MS;
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  // A connection failure rejects `opened` but may never emit `close`; keep the
  // success side pending so only the rejection can settle the synthesis race.
  const streamOpenFailure = stream.opened.then(
    () => new Promise<void>(() => undefined),
  );
  try {
    await Promise.race([
      stream.closed,
      streamOpenFailure,
      providerErrorSignal,
      new Promise<void>((resolve) => {
        timeoutId = setTimeout(() => {
          timedOut = true;
          stream.cancel("synthesis deadline exceeded");
          resolve();
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }

  if (providerError) throw providerError;
  if (timedOut) {
    throw new Error(`Cartesia synthesis timed out after ${timeoutMs}ms`);
  }
  if (overflowed) {
    throw new Error(
      `Cartesia audio exceeded the ${args.maxPcmBytes}-byte PCM cap`,
    );
  }
  if (pcmBytes === 0) {
    throw new Error("Cartesia returned no audio");
  }

  const pcm = new Uint8Array(pcmBytes);
  let offset = 0;
  for (const frame of frames) {
    pcm.set(frame, offset);
    offset += frame.byteLength;
  }
  return {
    wav: pcm16ToWav(pcm, args.sampleRate),
    pcmBytes,
    firstAudioMs,
    totalMs: Date.now() - started,
  };
}
