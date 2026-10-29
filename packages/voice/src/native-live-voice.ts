/**
 * Renderer transport for a native speech bridge (plugin-local-inference's
 * `LocalSpeechBridgePlugin` or a product subclass): continuous app-process microphone capture with
 * Silero VAD feeding the resident agent's on-device streaming ASR
 * (`POST /api/asr/local-inference/live`). Capacitor-agnostic: the host supplies the bridge as a
 * {@link NativeLiveCapturePort} and the resident agent binding as {@link NativeResidentBinding}.
 *
 * Two routes, chosen by the bridge's `liveCaptureStatus().nativeTransport`:
 *
 *  - native transport: the bridge routes VAD segments to the agent of the owner who started the
 *    capture; only levels, VAD edges, finals and the close acknowledgement cross the bridge, never
 *    PCM. Events are admitted only for the current capture id while the owner and session still
 *    hold; interim text comes only from the agent's event stream and only for the open turn.
 *  - renderer transport (a bridge without native routing): 16 kHz frames cross the bridge and
 *    `createLiveSegmentStream` posts them through an owner-fenced request port.
 *
 * Consumers: the conversation assistant (`nativeAssistantListener`, echo-cancelled, full duplex
 * only when the platform canceller is active) and Transcribe (`createNativeLiveDictation`, whose
 * Stop finalizes exactly the audio up to Stop and whose text only becomes an editable draft).
 * Nothing is stored or logged. No DOM, storage or platform imports.
 */
import {
  createLiveDictation,
  createLiveSegmentStream,
  LIVE_ASR_PATH,
  LIVE_ASR_STATUS_PATH,
  type LiveAudioFrame,
  type LiveCaptureOpenOptions,
  type LiveCaptureStream,
  type LiveVadEdge,
  type LiveVoiceLatency,
  type LiveVoiceTransport,
  liveAssistantListener,
  parseLiveFinal,
  parseVoiceTranscriptEnvelope,
} from "./live-voice-session.js";
import type {
  NativeVoiceStage,
  NativeVoiceStageSink,
} from "./voice-turn-timing.js";

export interface NativeListenerHandle {
  remove(): Promise<void>;
}
type BridgeEvent = Record<string, unknown> | null | undefined;
/** The live-capture methods and events of a native speech bridge. */
export interface NativeLiveCapturePort {
  liveCaptureStatus(): Promise<
    { available?: unknown; nativeTransport?: unknown } | null | undefined
  >;
  startLiveCapture(input: {
    captureId: string;
    echoCancel: boolean;
    nativeAsr?: true;
    ownerId?: string;
    roomId?: string;
  }): Promise<
    | {
        captureId?: unknown;
        sampleRate?: unknown;
        echoCancelled?: unknown;
        nativeAsr?: unknown;
      }
    | null
    | undefined
  >;
  stopLiveCapture(input: {
    captureId: string;
    discard?: boolean;
    cutoffMs?: number;
  }): Promise<
    | { captureId?: unknown; durationMs?: unknown; serverClosed?: unknown }
    | null
    | undefined
  >;
  addListener(
    event: "liveCaptureFrames" | "liveCaptureEnded" | "liveCaptureTranscript",
    callback: (event: BridgeEvent) => void,
  ): Promise<NativeListenerHandle>;
}
/**
 * The current owner's resident agent session. `request` is owner-authenticated; `subscribe`, when
 * present, is the agent's event stream (voice-transcript partials). `ownerId` is what the bridge
 * binds its own segment transport to.
 */
export interface NativeResidentBinding {
  sessionId: string;
  ownerId?: string;
  request(path: string, body: unknown, signal: AbortSignal): Promise<unknown>;
  subscribe?(listener: (envelope: unknown) => void): () => void;
}
export interface NativeLiveVoiceOptions {
  port: NativeLiveCapturePort;
  /** The bridge is present on this platform. */
  available(): boolean;
  /** The current resident binding, or null when no on-device agent is connected. */
  resident(): NativeResidentBinding | null;
  /** Capture ids; the bridge accepts 36-character UUIDs. */
  newCaptureId?: () => string;
  /** How long a renderer-transport stop waits for the bridge to report the end. */
  endedTimeoutMs?: number;
}
export type NativeCaptureOpenOptions = LiveCaptureOpenOptions;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const isFrame = (value: unknown): value is LiveAudioFrame => {
  if (!isRecord(value)) return false;
  return (
    typeof value.pcm16 === "string" &&
    value.pcm16.length <= 64 * 1024 &&
    value.sampleRate === 16000 &&
    value.channels === 1 &&
    Number.isSafeInteger(value.samples) &&
    (value.samples as number) > 0 &&
    Number.isFinite(value.timestamp)
  );
};
const isEdge = (value: unknown): value is LiveVadEdge =>
  isRecord(value) &&
  (value.type === "speech-start" || value.type === "speech-end") &&
  Number.isFinite(value.timestampMs);
const level = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, Math.min(1, value))
    : undefined;
const sessionChanged = () =>
  Object.assign(Error("The agent session changed."), { status: 409 });

/** Most finals a native capture may hold undelivered, and finished turn ids it remembers. */
export const NATIVE_PENDING_FINALS = 8;
export const NATIVE_FINISHED_TURNS = 512;

export interface NativeResidentCaptureInput extends LiveCaptureOpenOptions {
  ownerId: string;
  /** False once the owner or session the capture started for changed. */
  current(): boolean;
  subscribe?(listener: (envelope: unknown) => void): () => void;
  captureId?: string;
}
/**
 * One native capture whose VAD segments the bridge routes to the owner's resident agent. Events
 * for another capture id, after a stop or once `current()` fails are dropped (the last ends the
 * capture as lost). Finals are delivered once per turn, in VAD order; an ASR failure yields a null
 * segment. Partials from the event stream are display-only and only for the open turn.
 */
export async function openNativeResidentCapture(
  port: NativeLiveCapturePort,
  input: NativeResidentCaptureInput,
): Promise<LiveCaptureStream> {
  const captureId = input.captureId ?? crypto.randomUUID();
  const handles: NativeListenerHandle[] = [];
  let active = true;
  let stopping = false;
  let discarded = false;
  let speaking = false;
  let cutoff = Number.POSITIVE_INFINITY;
  let expected = 0;
  let startedAt = Date.now();
  let stopped: Promise<void> | undefined;
  let unsubscribe: (() => void) | undefined;
  let partialTurn = "";
  let partialSeq = 0;
  let partials = 0;
  const finished = new Set<string>();
  const pending: Array<ReturnType<typeof parseLiveFinal> | null> = [];
  const detach = async () => {
    unsubscribe?.();
    input.signal.removeEventListener("abort", abort);
    await Promise.all(
      handles.splice(0).map((handle) => handle.remove().catch(() => {})),
    );
  };
  const stop = (discard: boolean, at = Date.now()): Promise<void> => {
    const wasDiscarded = discarded;
    if (discard) {
      discarded = true;
      active = false;
      pending.length = 0;
    }
    // Abort can overtake a graceful close while its server request is still pending.
    if (stopped) {
      if (discard && !wasDiscarded)
        void port
          .stopLiveCapture({ captureId, discard: true, cutoffMs: at })
          .catch(() => {});
      return stopped;
    }
    stopping = true;
    stopped = (async () => {
      try {
        const ack = await port.stopLiveCapture({
          captureId,
          discard,
          cutoffMs: at,
        });
        if (!discard && ack?.serverClosed !== true)
          throw Error("Native transcription close was not confirmed.");
      } finally {
        active = false;
        await detach();
      }
    })();
    return stopped;
  };
  const abort = () => {
    void stop(true).catch(() => {});
  };
  const lose = (error: unknown) => {
    if (!active || stopping) return;
    void stop(true).catch(() => {});
    input.onLost(error);
  };
  const admitted = () => {
    if (!active) return false;
    if (!input.current()) {
      lose(sessionChanged());
      return false;
    }
    return true;
  };
  const drain = () => {
    while (active && expected > 0 && pending.length) {
      expected--;
      const final = pending.shift();
      input.onInterim?.("");
      input.onSegment(
        final?.text ?? null,
        final
          ? {
              mode: final.mode,
              partials,
              ...(final.asrFinalFromSpeechEndMs !== null
                ? { asrFinalFromSpeechEndMs: final.asrFinalFromSpeechEndMs }
                : {}),
            }
          : undefined,
      );
      partials = 0;
    }
  };
  const end = (at: number) => {
    if (!speaking) return;
    speaking = false;
    expected++;
    input.onSpeechEnd?.(at);
    drain();
  };
  try {
    input.signal.throwIfAborted();
    handles.push(
      await port.addListener("liveCaptureFrames", (event) => {
        if (event?.captureId !== captureId || !admitted()) return;
        // Never read a frames/PCM field, including from an older bridge that still sends them.
        const peak = level(event.peak);
        if (peak !== undefined) input.onLevel?.(peak);
        if (!Array.isArray(event.vad)) return;
        for (const edge of event.vad) {
          if (!isEdge(edge) || edge.timestampMs > cutoff) continue;
          if (edge.type === "speech-start" && !speaking) {
            speaking = true;
            input.onSpeechStart?.(edge.timestampMs);
          } else if (edge.type === "speech-end") end(edge.timestampMs);
        }
      }),
    );
    handles.push(
      await port.addListener("liveCaptureTranscript", (event) => {
        if (event?.captureId !== captureId || !admitted()) return;
        if (event.error) {
          if (event.error === "ASR_FAILED") {
            if (pending.length >= NATIVE_PENDING_FINALS) {
              lose(Error("Native transcription session limit reached."));
              return;
            }
            pending.push(null);
            drain();
          } else lose(Error("Native transcription unavailable."));
          return;
        }
        const final = parseLiveFinal(event.final);
        if (!final || finished.has(final.turnId)) return;
        if (
          finished.size >= NATIVE_FINISHED_TURNS ||
          pending.length >= NATIVE_PENDING_FINALS
        ) {
          lose(Error("Native transcription session limit reached."));
          return;
        }
        finished.add(final.turnId);
        if (partialTurn === final.turnId) {
          partialTurn = "";
          partialSeq = 0;
        }
        pending.push(final);
        drain();
      }),
    );
    handles.push(
      await port.addListener("liveCaptureEnded", (event) => {
        if (event?.captureId !== captureId || !admitted()) return;
        if (stopping) end(Math.min(cutoff, Date.now()));
        else
          lose(
            Object.assign(Error("The microphone stopped."), {
              code: "capture",
              ...(typeof event.error === "string"
                ? { reason: event.error }
                : {}),
            }),
          );
      }),
    );
    unsubscribe = input.subscribe?.((envelope) => {
      if (!admitted()) return;
      const event = parseVoiceTranscriptEnvelope(envelope, captureId);
      if (!event) return;
      // Bridge results are authoritative finals/errors; feed events provide display-only partials.
      if (event.phase === "speech-start") {
        partialTurn = event.turnId;
        partialSeq = 0;
        return;
      }
      if (event.phase !== "partial" || finished.has(event.turnId)) return;
      if (!partialTurn) partialTurn = event.turnId;
      if (event.turnId !== partialTurn || event.seq <= partialSeq) return;
      partialSeq = event.seq;
      partials++;
      input.onInterim?.(event.text);
    });
    input.signal.throwIfAborted();
    input.signal.addEventListener("abort", abort, { once: true });
    const result = await port.startLiveCapture({
      captureId,
      echoCancel: input.echoCancel,
      nativeAsr: true,
      ownerId: input.ownerId,
      ...(input.roomId ? { roomId: input.roomId } : {}),
    });
    input.signal.throwIfAborted();
    if (
      !active ||
      !input.current() ||
      result?.captureId !== captureId ||
      result.sampleRate !== 16000 ||
      result.nativeAsr !== true
    )
      throw Error("Native voice binding changed.");
    startedAt = Date.now();
    return {
      startedAt,
      echoCancelled: input.echoCancel && result.echoCancelled === true,
      speaking: () => speaking,
      async close(at = Date.now()) {
        cutoff = Math.min(cutoff, at);
        end(at);
        await stop(false, at);
        if (!discarded)
          while (expected > 0) {
            expected--;
            input.onSegment(null);
          }
        return { durationMs: Math.max(0, at - startedAt) };
      },
      async cancel() {
        await stop(true);
      },
    };
  } catch (error) {
    await stop(true).catch(() => {});
    throw error;
  }
}

/**
 * One native capture whose 16 kHz frames cross the bridge and are posted through `transport`
 * (a bridge without native routing).
 */
export async function openNativeSegmentCapture(
  port: NativeLiveCapturePort,
  transport: LiveVoiceTransport,
  input: LiveCaptureOpenOptions & {
    captureId?: string;
    endedTimeoutMs?: number;
  },
): Promise<LiveCaptureStream> {
  let accepting = true;
  let stopping = false;
  let lost = false;
  const lose = (error: unknown) => {
    if (stopping || lost) return;
    lost = true;
    input.onLost(error);
  };
  const stream = createLiveSegmentStream({
    transport,
    ...(input.roomId ? { roomId: input.roomId } : {}),
    onSpeechStart: (at) => input.onSpeechStart?.(at),
    onSpeechEnd: (at) => input.onSpeechEnd?.(at),
    onSegment: (text, latency) => input.onSegment(text, latency),
    onInterim: (text) => input.onInterim?.(text),
    onFatal: (code) =>
      lose(
        Object.assign(Error("On-device transcription is unavailable."), {
          code: "live-asr",
          reason: code,
        }),
      ),
  });
  const captureId = input.captureId ?? crypto.randomUUID();
  const handles: NativeListenerHandle[] = [];
  let ended!: () => void;
  const endedPromise = new Promise<void>((resolve) => {
    ended = resolve;
  });
  const detach = () =>
    Promise.all(
      handles.splice(0).map((handle) => handle.remove().catch(() => {})),
    );
  try {
    handles.push(
      await port.addListener("liveCaptureFrames", (event) => {
        if (!accepting || event?.captureId !== captureId) return;
        const frames = Array.isArray(event.frames)
          ? event.frames.filter(isFrame)
          : [];
        const vad = Array.isArray(event.vad) ? event.vad.filter(isEdge) : [];
        const peak = level(event.peak);
        if (peak !== undefined) input.onLevel?.(peak);
        void stream.accept(frames, vad);
      }),
    );
    handles.push(
      await port.addListener("liveCaptureEnded", (event) => {
        if (event?.captureId !== captureId) return;
        ended();
        if (!stopping) {
          accepting = false;
          lose(
            Object.assign(Error("The microphone stopped."), {
              code: "capture",
              ...(typeof event.error === "string"
                ? { reason: event.error }
                : {}),
            }),
          );
        }
      }),
    );
  } catch (error) {
    stream.cancel();
    await detach();
    throw error;
  }
  let stopped: Promise<void> | undefined;
  const stopNative = () => {
    stopped ??= (async () => {
      stopping = true;
      try {
        await port.stopLiveCapture({ captureId });
      } catch {
        /* Already stopped. */
      }
      // The bridge flushes its last frames before it reports the end (its stop waits up to 1.5 s).
      await Promise.race([
        endedPromise,
        new Promise((resolve) =>
          setTimeout(resolve, input.endedTimeoutMs ?? 2000),
        ),
      ]);
      accepting = false;
      await detach();
    })();
    return stopped;
  };
  const abort = () => {
    stream.cancel();
    void stopNative();
  };
  let echoCancelled = false;
  try {
    input.signal.throwIfAborted();
    input.signal.addEventListener("abort", abort, { once: true });
    const result = await port.startLiveCapture({
      captureId,
      echoCancel: input.echoCancel,
    });
    if (result?.captureId !== captureId || result.sampleRate !== 16000)
      throw Error("Live capture identity changed.");
    echoCancelled = input.echoCancel && result.echoCancelled === true;
    input.signal.throwIfAborted();
  } catch (error) {
    input.signal.removeEventListener("abort", abort);
    stream.cancel();
    await stopNative();
    throw error;
  }
  const startedAt = Date.now();
  return {
    startedAt,
    echoCancelled,
    speaking: () => stream.speaking(),
    async close(at = Date.now()) {
      input.signal.removeEventListener("abort", abort);
      stream.cutoff(at);
      await stopNative();
      await stream.close();
      return { durationMs: Math.max(0, at - startedAt) };
    },
    async cancel() {
      input.signal.removeEventListener("abort", abort);
      stream.cancel();
      await stopNative();
    },
  };
}

/** The live ASR route of the current resident session, refusing every request once it changed. */
export function residentLiveTransport(
  resident: () => NativeResidentBinding | null,
): LiveVoiceTransport | null {
  const binding = resident();
  if (!binding) return null;
  const session = binding.sessionId;
  const same = () => resident()?.sessionId === session;
  const subscribe = binding.subscribe;
  return {
    post: (body, signal) =>
      same()
        ? binding.request(LIVE_ASR_PATH, body, signal)
        : Promise.reject(sessionChanged()),
    ...(typeof subscribe === "function"
      ? {
          subscribe: (listener: (envelope: unknown) => void) =>
            subscribe.call(binding, (envelope) => {
              if (same()) listener(envelope);
            }),
        }
      : {}),
  };
}

/** The native live voice of one host: readiness, capture, assistant listen port and dictation. */
export function createNativeLiveVoice(options: NativeLiveVoiceOptions) {
  const { port } = options;
  /** The bridge has VAD capture and the agent reports a streaming live ASR loader. */
  async function ready(signal: AbortSignal): Promise<boolean> {
    if (!options.available()) return false;
    const resident = options.resident();
    if (!resident) return false;
    try {
      const status = await port.liveCaptureStatus();
      signal.throwIfAborted();
      if (status?.available !== true) return false;
      const agent = (await resident.request(
        LIVE_ASR_STATUS_PATH,
        undefined,
        signal,
      )) as { ready?: unknown } | null;
      signal.throwIfAborted();
      return agent?.ready === true;
    } catch (error) {
      if (signal.aborted) throw error;
      return false;
    }
  }
  /** Opens one capture and its agent live session on the route the bridge supports. */
  async function open(
    input: LiveCaptureOpenOptions,
  ): Promise<LiveCaptureStream> {
    if (!options.available()) throw Error("Live voice is unavailable.");
    input.signal.throwIfAborted();
    const transport = residentLiveTransport(options.resident);
    if (!transport) throw Error("The on-device agent is not connected.");
    const capability = await port.liveCaptureStatus();
    input.signal.throwIfAborted();
    const captureId = options.newCaptureId?.();
    if (capability?.nativeTransport === true) {
      const owner = options.resident();
      if (!owner?.ownerId) throw Error("The on-device agent is not connected.");
      const { ownerId, sessionId } = owner;
      return openNativeResidentCapture(port, {
        ...input,
        ...(captureId ? { captureId } : {}),
        ownerId,
        current: () => {
          const now = options.resident();
          return now?.ownerId === ownerId && now.sessionId === sessionId;
        },
        ...(owner.subscribe ? { subscribe: owner.subscribe.bind(owner) } : {}),
      });
    }
    // Compatibility with a bridge without native routing: PCM crosses the renderer on this path.
    return openNativeSegmentCapture(port, transport, {
      ...input,
      ...(captureId ? { captureId } : {}),
      ...(options.endedTimeoutMs !== undefined
        ? { endedTimeoutMs: options.endedTimeoutMs }
        : {}),
    });
  }
  return {
    ready,
    open,
    /** The voice assistant's listen port over the native capture (echo-cancelled). */
    assistantListener(
      listen: {
        roomId?: string;
        onInterim?: (text: string) => void;
        onLatency?: (latency: LiveVoiceLatency) => void;
      } = {},
    ) {
      return liveAssistantListener(open, listen);
    },
    /** Transcribe over the native capture: Stop finalizes exactly the audio up to Stop. */
    dictation(
      dictate: {
        roomId?: string;
        onInterim?: (text: string) => void;
        onLatency?: (latency: LiveVoiceLatency) => void;
        maxDurationMs?: number;
      } = {},
    ) {
      return createLiveDictation(open, dictate);
    },
  };
}
export type NativeLiveVoice = ReturnType<typeof createNativeLiveVoice>;

/** The native voice-turn latency methods of a speech bridge. */
export interface NativeVoiceTimingPort {
  markVoiceTurn(input: {
    stage: NativeVoiceStage;
    voiceTurnId?: string;
  }): Promise<{ marked?: unknown; voiceTurnId?: unknown } | null | undefined>;
  nativeVoiceTiming(): Promise<unknown>;
}
/**
 * The stage sink for `VoiceTurnTiming.setNativeStageSink`: forwards a stage name and the native
 * turn id it was given; the bridge stamps the monotonic time on arrival. No text, account or
 * conversation identifier is sent.
 */
export function nativeVoiceStageSink(
  port: NativeVoiceTimingPort,
): NativeVoiceStageSink {
  return async (stage, voiceTurnId) => {
    const result = await port.markVoiceTurn({
      stage,
      ...(voiceTurnId ? { voiceTurnId } : {}),
    });
    return typeof result?.voiceTurnId === "string"
      ? result.voiceTurnId
      : undefined;
  };
}
/** The bridge's timing export for diagnostics, or null when unavailable within the limit. */
export async function readNativeVoiceTiming(
  port: NativeVoiceTimingPort,
  timeoutMs = 10_000,
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      port.nativeVoiceTiming(),
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      }),
    ]);
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
