/**
 * Realtime voice-session client — the ONE browser implementation both the iOS
 * installed PWA and the LP3 Capacitor APK (WebView 113) use.
 *
 * Lifecycle (contract §7.1/§7.2/§7.4):
 *   1. mint: POST /api/v1/voice/session with the Eliza bearer/session →
 *      { sessionId, wsUrl, token, expiresAt, uplink, downlink }.
 *   2. open WSS, send the FIRST frame as a JSON `hello` carrying the token
 *      (NEVER a WS header — WebView 113 can't set them reliably).
 *   3. negotiated pcm16 16 kHz mono uplink/downlink. Handle every server event
 *      per §7.2. Reconnect = RE-MINT (a revoked/expired token can't reconnect).
 *   4. clean `bye` + close.
 *
 * The client wires:
 *   - voice-session-mic-capture (getUserMedia → AudioWorklet/ScriptProcessor →
 *     Int16 PCM uplink frames)
 *   - voice-session-playback (streaming PCM sink, no decodeAudioData barrier)
 *   - voice-session-state (the §7.4 machine, mapped into the unified voice
 *     status via toContinuousStatus)
 *
 * Barge-in: `bargeIn()` flushes local playback IMMEDIATELY and sends
 * `{t:"barge_in"}`; it does NOT wait for the server `interrupted` event to stop
 * audible output, but reconciles state when that event arrives.
 *
 * Trace: the client carries `traceId` from server events onto client playout
 * marks (`onTraceMark`). A mark never reached is reported as
 * `not_reached(reason)`, never synthesized and never renamed.
 *
 * Everything third-party (WebSocket ctor, AudioContext, getUserMedia, mint fetch)
 * is injectable so tests drive the REAL framing/state/barge-in/reconnect code
 * through fakes — not stubs of the client itself.
 */

import type { VoiceContinuousStatus } from "./voice-chat-types";
import {
  type MicAudioContextLike,
  startVoiceMicCapture,
  type VoiceMicCapture,
  VoiceMicCaptureError,
} from "./voice-session-mic-capture";
import {
  createVoiceSessionPlayback,
  type PlaybackAudioContextLike,
  type VoiceSessionPlayback,
} from "./voice-session-playback";
import {
  DEFAULT_DOWNLINK_CODEC,
  DEFAULT_UPLINK_CODEC,
  encodeClientControl,
  isUsableMintResponse,
  negotiateCodec,
  parseServerControl,
  type ServerControlFrame,
  VOICE_SESSION_PROTOCOL_VERSION,
  VOICE_SESSION_SAMPLE_RATE,
  type VoiceSessionCodec,
  type VoiceSessionMintResponse,
} from "./voice-session-protocol";
import {
  applyClientAction,
  applyServerEvent,
  beginListening,
  INITIAL_VOICE_SESSION_STATE,
  loopToListening,
  toContinuousStatus,
  type VoiceSessionMachineState,
} from "./voice-session-state";

/** Minimal WebSocket surface the client drives (native or fake). */
export interface VoiceWebSocketLike {
  binaryType: string;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(
    type: "message",
    listener: (event: { data: unknown }) => void,
  ): void;
  addEventListener(
    type: "close",
    listener: (event: { code?: number; reason?: string }) => void,
  ): void;
  addEventListener(type: "error", listener: () => void): void;
}

function isVoiceWebSocketLike(value: unknown): value is VoiceWebSocketLike {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof Reflect.get(value, "binaryType") === "string" &&
    typeof Reflect.get(value, "send") === "function" &&
    typeof Reflect.get(value, "close") === "function" &&
    typeof Reflect.get(value, "addEventListener") === "function"
  );
}

function closeInvalidNativeWebSocket(socket: unknown): void {
  if ((typeof socket !== "object" && typeof socket !== "function") || !socket) {
    return;
  }
  try {
    const close: unknown = Reflect.get(socket, "close");
    if (typeof close === "function") Reflect.apply(close, socket, []);
  } catch (ignoredError) {
    // error-policy:J6 Best-effort cleanup must not mask the runtime shape error.
    void ignoredError;
  }
}

function openNativeVoiceWebSocket(url: string): VoiceWebSocketLike {
  const ctor: unknown = globalThis.WebSocket;
  if (typeof ctor !== "function") {
    throw new Error("WebSocket is unavailable in this runtime");
  }
  const socket: unknown = Reflect.construct(ctor, [url]);
  if (!isVoiceWebSocketLike(socket)) {
    closeInvalidNativeWebSocket(socket);
    throw new Error("WebSocket runtime does not expose the required voice API");
  }
  return socket;
}

export type VoiceWebSocketFactory = (url: string) => VoiceWebSocketLike;

/** A client playout trace mark, carrying the server-issued traceId. */
export interface VoiceTraceMark {
  name: string;
  traceId: string | null;
  atMs: number;
}

export interface VoiceSessionClientOptions {
  agentId: string;
  conversationId: string;
  /** Consent nonce from POST /api/v1/voice/session/consent (SEC-21). */
  consentNonce: string;

  /**
   * Injectable mint fetch. Defaults to the CSRF/bearer dashboard fetch
   * (`fetchWithCsrf`), lazily imported so this module's static graph stays lean
   * (the dashboard fetch pulls the boot-config/core chain). A caller in a
   * non-dashboard host (or a test) supplies its own.
   */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** Base path for the mint route. Default "/api/v1/voice/session". */
  mintPath?: string;
  /** Injectable WebSocket factory (tests / non-standard hosts). */
  webSocketFactory?: VoiceWebSocketFactory;
  /** Injectable getUserMedia (passed to mic capture). */
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
  /** Injectable mic AudioContext factory (tests). */
  createMicAudioContext?: () => MicAudioContextLike;
  /** Injectable playback AudioContext factory (tests). */
  createPlaybackAudioContext?: () => PlaybackAudioContextLike;

  /** Preferred uplink codec (default pcm16). */
  uplinkCodec?: VoiceSessionCodec;
  /** Preferred downlink codec (default pcm16). */
  downlinkCodec?: VoiceSessionCodec;

  /** Fired on every state change with the new machine state + unified status. */
  onState?: (
    state: VoiceSessionMachineState,
    status: VoiceContinuousStatus,
  ) => void;
  /** Fired for each raw server control event (after state fold). */
  onServerEvent?: (event: ServerControlFrame) => void;
  /** Fired for each client playout trace mark. */
  onTraceMark?: (mark: VoiceTraceMark) => void;
  /** Fired on a fatal client error (mic/permission/transport). */
  onError?: (error: Error) => void;
  /** Monotonic clock for trace marks (tests inject). */
  now?: () => number;

  /**
   * Max reconnect (re-mint) attempts on a non-clean close before giving up.
   * Default 2. A revoked/expired token cannot reconnect — reconnect ALWAYS
   * re-mints a fresh token, never reuses the old one.
   */
  maxReconnects?: number;
}

type ConnectionPhase = "idle" | "connecting" | "open" | "closing" | "closed";

export interface VoiceSessionClient {
  /** Current machine state (immutable snapshot). */
  readonly state: VoiceSessionMachineState;
  /** Mint + connect + start capture/playback. */
  start(): Promise<void>;
  /** Barge-in: flush local playback NOW + notify server. */
  bargeIn(): void;
  /** Unlock playback on a user gesture (iOS autoplay). */
  unlockPlayback(): Promise<void>;
  /** Send a clean `bye` and tear everything down. */
  stop(): Promise<void>;
}

function nowDefault(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

export function createVoiceSessionClient(
  options: VoiceSessionClientOptions,
): VoiceSessionClient {
  const now = options.now ?? nowDefault;
  const mintPath = options.mintPath ?? "/api/v1/voice/session";
  const doFetch =
    options.fetch ??
    (async (url: string, init?: RequestInit) => {
      const { fetchWithCsrf } = await import("../api/csrf-client");
      return fetchWithCsrf(url, init);
    });
  const wsFactory =
    options.webSocketFactory ??
    ((url: string) => openNativeVoiceWebSocket(url));
  const preferredUplink = options.uplinkCodec ?? DEFAULT_UPLINK_CODEC;
  const preferredDownlink = options.downlinkCodec ?? DEFAULT_DOWNLINK_CODEC;
  const maxReconnects = options.maxReconnects ?? 2;

  let state: VoiceSessionMachineState = { ...INITIAL_VOICE_SESSION_STATE };
  let connPhase: ConnectionPhase = "idle";
  let ws: VoiceWebSocketLike | null = null;
  let mic: VoiceMicCapture | null = null;
  let playback: VoiceSessionPlayback | null = null;
  let reconnectsUsed = 0;
  let disposed = false;
  // Whether the caller explicitly stopped us (clean bye) — suppresses reconnect.
  let intentionalClose = false;

  const setState = (next: VoiceSessionMachineState): void => {
    state = next;
    options.onState?.(state, toContinuousStatus(state.phase));
  };

  const mark = (name: string, traceId: string | null): void => {
    options.onTraceMark?.({ name, traceId, atMs: now() });
  };

  const emitError = (error: Error): void => {
    options.onError?.(error);
  };

  async function mint(): Promise<VoiceSessionMintResponse> {
    const res = await doFetch(mintPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agentId: options.agentId,
        conversationId: options.conversationId,
        transport: "websocket",
        consentNonce: options.consentNonce,
      }),
    });
    if (!res.ok) {
      // 404 => flag off; caller falls back to batch. Surface as a typed error.
      throw new VoiceSessionMintError(res.status);
    }
    const json = (await res.json()) as unknown;
    if (!isUsableMintResponse(json)) {
      throw new VoiceSessionMintError(-1, "malformed mint response");
    }
    return json;
  }

  function sendControl(frame: Parameters<typeof encodeClientControl>[0]): void {
    if (!ws || connPhase !== "open") return;
    try {
      ws.send(encodeClientControl(frame));
    } catch (ignoredError) {
      void ignoredError;
      // socket closing; the close handler will drive reconnect/teardown.
    }
  }

  function sendUplinkAudio(bytes: Uint8Array): void {
    if (!ws || connPhase !== "open") return;
    try {
      // Copy into a standalone ArrayBuffer so a shared/pooled backing store from
      // the capture path is never observed mutated after send.
      ws.send(bytes.slice().buffer);
    } catch (ignoredError) {
      void ignoredError;
      // dropped; reconnect logic handles a dead socket.
    }
  }

  function handleServerFrame(data: unknown): void {
    // Binary downlink audio → straight to the streaming playback sink.
    if (data instanceof ArrayBuffer) {
      playback?.enqueue(new Uint8Array(data));
      mark("downlink_audio", state.traceId);
      return;
    }
    if (ArrayBuffer.isView(data)) {
      const view = data as ArrayBufferView;
      playback?.enqueue(
        new Uint8Array(view.buffer, view.byteOffset, view.byteLength),
      );
      mark("downlink_audio", state.traceId);
      return;
    }

    // Text control frame.
    const raw = typeof data === "string" ? data : null;
    if (raw === null) {
      // Neither binary nor text — a malformed frame. Never fabricate an event;
      // record it as a not-reached trace and ignore.
      mark("not_reached(malformed_frame)", state.traceId);
      return;
    }
    const event = parseServerControl(raw);
    if (!event) {
      // Unknown/invalid control frame: a single bad frame must not kill the
      // session. Record + ignore.
      mark("not_reached(unparseable_control)", state.traceId);
      return;
    }

    const prevPhase = state.phase;
    setState(applyServerEvent(state, event));
    options.onServerEvent?.(event);

    switch (event.t) {
      case "ready":
        mark("ready", event.traceId);
        // Client-owned: begin capture, then listening.
        void startCapture();
        break;
      case "stt_final":
        mark("stt_final", event.traceId);
        break;
      case "llm_first_text":
        mark("llm_first_text", event.traceId);
        break;
      case "speaking_start":
        mark("speaking_start", event.traceId);
        break;
      case "speaking_end":
        mark("speaking_end", event.traceId);
        // Turn complete → loop back to listening once emitted.
        setState(loopToListening(state));
        break;
      case "interrupted":
        // Reconcile: the server confirms the interruption. Ensure local audio is
        // silenced (idempotent with an optimistic local flush) and loop to
        // listening.
        playback?.flush();
        mark("interrupted", event.traceId);
        setState(loopToListening(state));
        break;
      case "error":
        if (!event.retryable) {
          // Fatal server error: tear down and (unless intentional) re-mint.
          mark("not_reached(server_fatal_error)", state.traceId);
          void handleTransportLoss("server_error");
        }
        break;
      case "usage":
      case "stt_partial":
      case "stt_eager_eot":
        break;
    }
    void prevPhase;
  }

  async function startCapture(): Promise<void> {
    if (mic || disposed) return;
    try {
      mic = await startVoiceMicCapture({
        onFrame: (bytes) => sendUplinkAudio(bytes),
        onSuspend: () => mark("mic_suspended", state.traceId),
        onResume: () => mark("mic_resumed", state.traceId),
        onError: (err) => emitError(err),
        getUserMedia: options.getUserMedia,
        createAudioContext: options.createMicAudioContext,
      });
      // Now genuinely listening.
      setState(beginListening(state));
    } catch (err) {
      const error =
        err instanceof VoiceMicCaptureError
          ? err
          : new VoiceMicCaptureError("mic capture failed", "start_failed", err);
      emitError(error);
      // Without a mic there's no session; tear down cleanly.
      void stop();
    }
  }

  async function openConnection(
    minted: VoiceSessionMintResponse,
  ): Promise<void> {
    const uplink = negotiateCodec(preferredUplink, minted.uplink?.codecs);
    const downlink = negotiateCodec(preferredDownlink, minted.downlink?.codecs);
    if (!uplink || !downlink) {
      throw new VoiceSessionMintError(-1, "no compatible codec offered");
    }

    connPhase = "connecting";
    const socket = wsFactory(minted.wsUrl);
    socket.binaryType = "arraybuffer";
    ws = socket;

    socket.addEventListener("open", () => {
      connPhase = "open";
      // FIRST frame MUST be the hello with the token — never a header.
      sendControl({
        t: "hello",
        token: minted.token,
        protocol: VOICE_SESSION_PROTOCOL_VERSION,
        uplinkCodec: uplink,
        downlinkCodec: downlink,
        sampleRate: VOICE_SESSION_SAMPLE_RATE,
      });
      mark("hello_sent", null);
    });

    socket.addEventListener("message", (event) => {
      handleServerFrame(event.data);
    });

    socket.addEventListener("close", (event) => {
      if (connPhase === "closing" || intentionalClose) {
        connPhase = "closed";
        return;
      }
      connPhase = "closed";
      // Non-clean close (code 1000 is clean): attempt a reconnect via RE-MINT.
      const clean = event.code === 1000;
      if (!clean) {
        void handleTransportLoss("ws_close");
      }
    });

    socket.addEventListener("error", () => {
      // The close handler follows an error and drives reconnect; nothing to do
      // here beyond a trace mark.
      mark("ws_error", state.traceId);
    });
  }

  async function handleTransportLoss(reason: string): Promise<void> {
    if (disposed || intentionalClose) return;
    // Stop capture (a dead socket must not keep the mic hot) but KEEP playback
    // context so an autoplay unlock survives the reconnect.
    await teardownMic();
    if (reconnectsUsed >= maxReconnects) {
      mark(`not_reached(reconnect_exhausted:${reason})`, state.traceId);
      emitError(new Error(`voice session lost: ${reason}`));
      await stop();
      return;
    }
    reconnectsUsed += 1;
    mark(`reconnect_remint(${reason})`, state.traceId);
    try {
      // Reconnect ALWAYS re-mints; the old token is revoked/expired and cannot
      // reconnect (contract §7.1).
      const minted = await mint();
      setState({ ...state, phase: "connecting", lastError: null });
      await openConnection(minted);
    } catch (err) {
      emitError(err instanceof Error ? err : new Error(String(err)));
      await stop();
    }
  }

  async function teardownMic(): Promise<void> {
    if (mic) {
      const m = mic;
      mic = null;
      await m.stop().catch(() => {});
    }
  }

  async function stop(): Promise<void> {
    if (disposed) return;
    disposed = true;
    intentionalClose = true;
    // Clean bye if the socket is open.
    if (ws && connPhase === "open") {
      sendControl({ t: "bye" });
      connPhase = "closing";
      try {
        ws.close(1000, "client bye");
      } catch (ignoredError) {
        void ignoredError;
        /* already closing */
      }
    } else if (ws) {
      try {
        ws.close(1000, "client bye");
      } catch (ignoredError) {
        void ignoredError;
        /* noop */
      }
    }
    ws = null;
    await teardownMic();
    if (playback) {
      const p = playback;
      playback = null;
      await p.stop().catch(() => {});
    }
    connPhase = "closed";
    setState({ ...INITIAL_VOICE_SESSION_STATE });
  }

  return {
    get state() {
      return state;
    },

    async start() {
      if (connPhase !== "idle" && connPhase !== "closed") return;
      disposed = false;
      intentionalClose = false;
      reconnectsUsed = 0;
      setState({ ...INITIAL_VOICE_SESSION_STATE, phase: "connecting" });
      // Create playback up front so an early user-gesture unlock is possible and
      // downlink frames after `ready` have a sink.
      try {
        playback = await createVoiceSessionPlayback({
          createAudioContext: options.createPlaybackAudioContext,
          onDrained: () => mark("playback_drained", state.traceId),
        });
      } catch (err) {
        emitError(err instanceof Error ? err : new Error(String(err)));
        setState({ ...INITIAL_VOICE_SESSION_STATE });
        return;
      }
      try {
        const minted = await mint();
        await openConnection(minted);
      } catch (err) {
        emitError(err instanceof Error ? err : new Error(String(err)));
        await stop();
      }
    },

    bargeIn() {
      // Flush local audible output IMMEDIATELY — do NOT wait for the server
      // `interrupted` event. Then optimistically fold state and notify server.
      playback?.flush();
      setState(applyClientAction(state, { type: "client/local_barge_in" }));
      sendControl({ t: "barge_in" });
      mark("barge_in_sent", state.traceId);
    },

    async unlockPlayback() {
      await playback?.unlock();
      mark("playback_unlocked", state.traceId);
    },

    stop,
  };
}

/** A mint failure the caller can branch on (404 = flag off → batch fallback). */
export class VoiceSessionMintError extends Error {
  constructor(
    readonly status: number,
    message?: string,
  ) {
    super(message ?? `voice session mint failed (${status})`);
    this.name = "VoiceSessionMintError";
  }

  /** True when the realtime feature is off; the caller should use batch. */
  get isFeatureDisabled(): boolean {
    return this.status === 404;
  }
}
