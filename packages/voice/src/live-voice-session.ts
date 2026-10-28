/**
 * Client for the on-device live ASR route of plugin-local-inference.
 *
 * The host app process captures the microphone and runs Silero VAD (on Android the shared
 * `ai.eliza.voice.LiveVoiceCapture`), and the resident agent transcribes the stream on the device
 * with its Phonon-2 streaming decoder (`POST /api/asr/local-inference/live`). Nothing here sends
 * audio anywhere else.
 *
 * Wire contract (plugin-local-inference `routes/local-inference-asr-live.ts`):
 *   request  {sessionId, roomId?, frames?: AudioFrameEvent[], vad?: [{type, timestampMs}], close?}
 *   response {ok, sessionId, mode, framesReceived, final?: {turnId, text, mode, asrFinalFromSpeechEndMs}}
 * Interim text arrives only as ephemeral `voice-transcript` agent events (`agent_event`
 * envelopes on the agent's event socket): speech-start, partial (the full running text, not a
 * delta, with an increasing seq), final, error. Each carries the client's sessionId and the
 * turnId of one VAD segment.
 *
 * Rules kept here:
 *  - Partials are interim display only. They replace the previous interim text, are held in this
 *    closure and never stored, logged, sent as a message or written to a draft.
 *  - Events from another session, or from a turn that is not the current one, are dropped.
 *  - A turn's final is delivered once (it can arrive both in the HTTP response and as an event);
 *    the host applies its own send policy to it.
 *  - Latency is reported as numbers only.
 *
 * {@link createLiveSegmentStream} maps one continuous capture onto that session: one result per
 * closed VAD segment, with stop reconciliation (`cutoff`) and discard (`cancel`).
 *
 * Pure module (no Capacitor, DOM, storage or logging): hosts supply the transport.
 */

import type {
  AssistantCapture,
  AssistantListenHandlers,
} from "./voice-assistant-session.js";

export const LIVE_ASR_PATH = "/api/asr/local-inference/live";
export const LIVE_ASR_STATUS_PATH = "/api/asr/local-inference/live/status";
export const LIVE_SAMPLE_RATE = 16000;
const MAX_TEXT = 16000;
const MAX_FRAMES_PER_POST = 64;

export type LiveAudioFrame = {
  pcm16: string;
  sampleRate: 16000;
  channels: 1;
  samples: number;
  timestamp: number;
};
export type LiveVadEdge = {
  type: "speech-start" | "speech-end";
  timestampMs: number;
};
export type LiveMode = "stream" | "batch" | "unknown";
export type LiveFinal = {
  turnId: string;
  text: string;
  mode: LiveMode;
  asrFinalFromSpeechEndMs: number | null;
};
/** Numbers only: no text, no identifiers beyond the random turn id the caller already holds. */
export type LiveVoiceLatency = {
  mode: LiveMode;
  partials: number;
  firstPartialMs?: number;
  finalFromSpeechEndMs?: number;
  asrFinalFromSpeechEndMs?: number;
};

export interface LiveVoiceTransport {
  /** One POST to LIVE_ASR_PATH through the owner-authenticated local agent transport. */
  post(body: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  /**
   * The agent's event stream (`agent_event` envelopes), when this transport carries one. A
   * request-only transport (for example a port-free native agent IPC) carries none; the caller
   * then shows no interim text and receives the final from the HTTP response.
   */
  subscribe?(listener: (envelope: unknown) => void): () => void;
}

export interface LiveVoiceSessionOptions {
  transport: LiveVoiceTransport;
  roomId?: string;
  now?: () => number;
  /** Replace the interim text ('' clears it). Display only. */
  onInterim?: (text: string) => void;
  onFinal?: (final: LiveFinal, latency: LiveVoiceLatency) => void;
  onError?: (code: "ASR_FAILED" | "LIVE_ASR_UNAVAILABLE" | "TRANSPORT") => void;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
const isTurnId = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= 128;
const mode = (value: unknown): LiveMode =>
  value === "stream" || value === "batch" ? value : "unknown";
const boundedText = (value: unknown): string | undefined =>
  typeof value === "string" && value.length <= MAX_TEXT ? value : undefined;
const millis = (value: unknown): number | null =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= 0 &&
  value < 3_600_000
    ? Math.round(value)
    : null;

/** Parse a live-route `final` object. Returns undefined for anything else. */
export function parseLiveFinal(value: unknown): LiveFinal | undefined {
  if (!isRecord(value) || !isTurnId(value.turnId)) return;
  const text = boundedText(value.text);
  if (text === undefined) return;
  return {
    turnId: value.turnId,
    text: text.trim(),
    mode: mode(value.mode),
    asrFinalFromSpeechEndMs: millis(value.asrFinalFromSpeechEndMs),
  };
}

export type LiveTranscriptEvent =
  | { phase: "speech-start"; turnId: string }
  | { phase: "partial"; turnId: string; text: string; seq: number }
  | { phase: "final"; final: LiveFinal }
  | { phase: "error"; turnId: string };

/** Accepts only a `voice-transcript` agent_event for `sessionId`; everything else is ignored. */
export function parseVoiceTranscriptEnvelope(
  envelope: unknown,
  sessionId: string,
): LiveTranscriptEvent | undefined {
  if (
    !isRecord(envelope) ||
    envelope.type !== "agent_event" ||
    envelope.stream !== "voice-transcript"
  )
    return;
  const payload = envelope.payload;
  if (
    !isRecord(payload) ||
    payload.type !== "voice-transcript" ||
    payload.sessionId !== sessionId ||
    !isTurnId(payload.turnId)
  )
    return;
  switch (payload.phase) {
    case "speech-start":
      return { phase: "speech-start", turnId: payload.turnId };
    case "partial": {
      const text = boundedText(payload.text);
      if (
        text === undefined ||
        !Number.isSafeInteger(payload.seq) ||
        (payload.seq as number) < 1
      )
        return;
      return {
        phase: "partial",
        turnId: payload.turnId,
        text,
        seq: payload.seq as number,
      };
    }
    case "final": {
      const final = parseLiveFinal(payload);
      return final ? { phase: "final", final } : undefined;
    }
    case "error":
      return { phase: "error", turnId: payload.turnId };
    default:
      return;
  }
}

function randomId(): string {
  const value =
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  return `live-${value}`;
}

/**
 * One live session per voice conversation. `push` forwards the app-process frames and VAD edges
 * in order (one request at a time); `endTurn` closes an open segment when the conversation stops
 * listening for its own reasons; `close` finalizes and releases the agent session.
 */
export function createLiveVoiceSession(options: LiveVoiceSessionOptions) {
  const sessionId = randomId();
  const now =
    options.now ??
    (() =>
      typeof performance !== "undefined" &&
      typeof performance.now === "function"
        ? performance.now()
        : Date.now());
  const controller = new AbortController();
  let chain: Promise<void> = Promise.resolve();
  let disposed = false;
  let current: string | undefined;
  let lastSeq = 0;
  let interim = "";
  const finalized = new Set<string>();
  // Client clock marks for the open utterance (numbers only).
  let speechStartAt: number | undefined;
  let speechEndAt: number | undefined;
  let firstPartialAt: number | undefined;
  let partials = 0;
  let responseMode: LiveMode = "unknown";
  // A failed turn is reported by its 502 response and, where an event stream exists, also by an
  // error event. Each report from one source cancels one unmatched report from the other.
  const deduplicate = typeof options.transport.subscribe === "function";
  let eventFailures = 0;
  let responseFailures = 0;
  const failed = (source: "event" | "response") => {
    if (deduplicate && source === "event" && responseFailures > 0) {
      responseFailures--;
      return false;
    }
    if (deduplicate && source === "response" && eventFailures > 0) {
      eventFailures--;
      return false;
    }
    if (deduplicate) {
      if (source === "event") eventFailures++;
      else responseFailures++;
    }
    return true;
  };
  const waiting: Array<(final: LiveFinal | null) => void> = [];

  const setInterim = (text: string) => {
    if (text === interim) return;
    interim = text;
    options.onInterim?.(text);
  };
  const resetTurnMarks = () => {
    speechStartAt = undefined;
    speechEndAt = undefined;
    firstPartialAt = undefined;
    partials = 0;
  };
  const deliver = (final: LiveFinal) => {
    if (disposed || finalized.has(final.turnId)) return;
    // A final for an older turn than the one in progress is still that utterance's text; a
    // final never revives a turn once a later one was finalized.
    finalized.add(final.turnId);
    const at = now();
    const latency: LiveVoiceLatency = {
      mode: final.mode !== "unknown" ? final.mode : responseMode,
      partials,
      ...(firstPartialAt !== undefined && speechStartAt !== undefined
        ? {
            firstPartialMs: Math.max(
              0,
              Math.round(firstPartialAt - speechStartAt),
            ),
          }
        : {}),
      ...(speechEndAt !== undefined
        ? { finalFromSpeechEndMs: Math.max(0, Math.round(at - speechEndAt)) }
        : {}),
      ...(final.asrFinalFromSpeechEndMs !== null
        ? { asrFinalFromSpeechEndMs: final.asrFinalFromSpeechEndMs }
        : {}),
    };
    if (current === undefined || current === final.turnId) {
      current = undefined;
      lastSeq = 0;
      setInterim("");
    }
    resetTurnMarks();
    options.onFinal?.(final, latency);
    for (const resolve of waiting.splice(0)) resolve(final);
  };
  const onEvent = (envelope: unknown) => {
    if (disposed) return;
    const event = parseVoiceTranscriptEnvelope(envelope, sessionId);
    if (!event) return;
    if (event.phase === "final") {
      deliver(event.final);
      return;
    }
    if (finalized.has(event.turnId)) return; // a finished turn's late event
    if (event.phase === "speech-start") {
      current = event.turnId;
      lastSeq = 0;
      setInterim("");
      return;
    }
    if (current === undefined) {
      // The speech-start event was missed.
      current = event.turnId;
      lastSeq = 0;
    }
    if (event.turnId !== current) return; // stale turn
    if (event.phase === "partial") {
      if (event.seq <= lastSeq) return;
      lastSeq = event.seq;
      partials++;
      if (firstPartialAt === undefined) firstPartialAt = now();
      setInterim(event.text);
      return;
    }
    // error: the turn produced no transcript.
    current = undefined;
    lastSeq = 0;
    setInterim("");
    resetTurnMarks();
    if (!failed("event")) return;
    options.onError?.("ASR_FAILED");
    for (const resolve of waiting.splice(0)) resolve(null);
  };
  const unsubscribe = options.transport.subscribe?.(onEvent);

  const send = (body: Record<string, unknown>) => {
    const run = async () => {
      if (disposed) return;
      let response: unknown;
      try {
        response = await options.transport.post(
          {
            sessionId,
            ...(options.roomId ? { roomId: options.roomId } : {}),
            ...body,
          },
          controller.signal,
        );
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        const status = (error as { status?: unknown })?.status;
        // 502 with code ASR_FAILED is the route's per-turn failure: that segment has no transcript.
        if (
          status === 502 &&
          (error as { data?: { code?: unknown } })?.data?.code === "ASR_FAILED"
        ) {
          current = undefined;
          lastSeq = 0;
          setInterim("");
          resetTurnMarks();
          if (failed("response")) options.onError?.("ASR_FAILED");
          for (const resolve of waiting.splice(0)) resolve(null);
          return;
        }
        options.onError?.(
          status === 503 || status === 429
            ? "LIVE_ASR_UNAVAILABLE"
            : "TRANSPORT",
        );
        for (const resolve of waiting.splice(0)) resolve(null);
        return;
      }
      if (disposed || !isRecord(response)) return;
      responseMode = mode(response.mode);
      const final = parseLiveFinal(response.final);
      if (final) deliver(final);
    };
    const next = chain.then(run, run);
    chain = next.catch(() => {});
    return next;
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    controller.abort();
    unsubscribe?.();
    setInterim("");
    current = undefined;
    for (const resolve of waiting.splice(0)) resolve(null);
  };

  return {
    sessionId,
    /** Interim text currently shown ('' when none). */
    interim: () => interim,
    /** Forward app-process frames (16 kHz mono s16, base64) and the VAD edges for that audio. */
    push(frames: readonly LiveAudioFrame[], vad: readonly LiveVadEdge[] = []) {
      if (disposed) return Promise.resolve();
      const at = now();
      for (const edge of vad) {
        if (edge.type === "speech-start") {
          resetTurnMarks();
          speechStartAt = at;
        } else speechEndAt = at;
      }
      const posts: Promise<void>[] = [];
      for (
        let index = 0;
        index < Math.max(1, frames.length);
        index += MAX_FRAMES_PER_POST
      ) {
        const slice = frames.slice(index, index + MAX_FRAMES_PER_POST);
        const first = index === 0;
        const last = index + MAX_FRAMES_PER_POST >= frames.length;
        // speech-start rides with the first slice, speech-end with the last (the route applies
        // start edges, then frames, then end edges within one request).
        const edges = vad.filter(
          (edge) =>
            (edge.type === "speech-start" && first) ||
            (edge.type === "speech-end" && last),
        );
        if (!slice.length && !edges.length) continue;
        posts.push(
          send({
            ...(slice.length ? { frames: slice } : {}),
            ...(edges.length ? { vad: edges } : {}),
          }),
        );
      }
      return Promise.all(posts).then(() => {});
    },
    /** Resolves with the next delivered final (or null on a turn error / transport failure). */
    nextFinal(signal?: AbortSignal): Promise<LiveFinal | null> {
      if (disposed) return Promise.resolve(null);
      return new Promise((resolve, reject) => {
        const settle = (value: LiveFinal | null) => {
          signal?.removeEventListener("abort", abort);
          resolve(value);
        };
        const abort = () => {
          const index = waiting.indexOf(settle);
          if (index >= 0) waiting.splice(index, 1);
          reject(
            signal?.reason ??
              new DOMException("Live voice cancelled", "AbortError"),
          );
        };
        if (signal?.aborted) {
          abort();
          return;
        }
        signal?.addEventListener("abort", abort, { once: true });
        waiting.push(settle);
      });
    },
    /** Close the open segment now (the conversation decided the user finished). */
    endTurn(atMs?: number) {
      speechEndAt ??= now();
      return send({
        vad: [
          {
            type: "speech-end",
            timestampMs:
              atMs !== undefined && Number.isFinite(atMs) ? atMs : Date.now(),
          },
        ],
      });
    },
    /** Finalize any open segment and release the agent session. */
    async close() {
      if (disposed) return;
      try {
        await send({ close: true });
      } finally {
        dispose();
      }
    },
    dispose,
  };
}
export type LiveVoiceSession = ReturnType<typeof createLiveVoiceSession>;

/** `agent_event` envelopes from an agent event WebSocket (`/ws`), for transports that have one. */
export function webSocketAgentEvents(
  open: () => WebSocket,
): (listener: (envelope: unknown) => void) => () => void {
  return (listener) => {
    const socket = open();
    const message = (event: MessageEvent) => {
      if (typeof event.data !== "string" || event.data.length > 64 * 1024)
        return;
      try {
        listener(JSON.parse(event.data));
      } catch {
        /* Not an event frame. */
      }
    };
    socket.addEventListener("message", message);
    return () => {
      socket.removeEventListener("message", message);
      try {
        socket.close();
      } catch {
        /* Already closed. */
      }
    };
  };
}

/** Encode Float32 PCM in [-1, 1] as one 16 kHz mono s16 base64 frame (the AudioFrameEvent wire format). */
export function encodeLiveFrame(
  samples: Float32Array,
  timestamp: number,
): LiveAudioFrame {
  const bytes = new Uint8Array(samples.length * 2);
  for (let index = 0; index < samples.length; index++) {
    const value = Math.max(-1, Math.min(1, samples[index] || 0));
    const int = Math.round(value < 0 ? value * 32768 : value * 32767);
    bytes[index * 2] = int & 0xff;
    bytes[index * 2 + 1] = (int >> 8) & 0xff;
  }
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return {
    pcm16: btoa(binary),
    sampleRate: LIVE_SAMPLE_RATE,
    channels: 1,
    samples: samples.length,
    timestamp,
  };
}

export interface LiveSegmentHandlers {
  onSpeechStart?(atMs: number): void;
  onSpeechEnd?(atMs: number): void;
  onSegment(text: string | null, latency?: LiveVoiceLatency): void;
  /** The agent route is unavailable or the transport failed: the stream is unusable. */
  onFatal?(code: "LIVE_ASR_UNAVAILABLE" | "TRANSPORT"): void;
  onInterim?(text: string): void;
}

/**
 * One continuous live capture mapped onto the agent's live ASR session: every VAD segment the
 * app process opens is forwarded with its frames, and every segment it closes yields exactly one
 * result (the agent's final transcript, or null when the segment produced none).
 *
 * Stop reconciliation: `cutoff(at)` marks the moment the user stopped, before the native capture
 * has finished stopping. Frames and edges stamped after `at` (still in flight from the native
 * thread) are dropped; frames up to `at` keep arriving through `accept`. Once the capture has
 * stopped, `close()` closes an open segment at `at` and delivers its final before resolving, so a
 * transcript holds exactly the audio up to the stop. `cancel()` discards: no further result is
 * delivered and the agent session is released.
 *
 * Interim text (`onInterim`) needs a transport with an event stream (`subscribe`). A request-only
 * transport delivers finals only; nothing is synthesized in place of a partial.
 */
export function createLiveSegmentStream(
  input: {
    transport: LiveVoiceTransport;
    roomId?: string;
    now?: () => number;
  } & LiveSegmentHandlers,
) {
  let open = false;
  let cut: number | undefined;
  let finished = false;
  let discarded = false;
  let expected = 0;
  const session = createLiveVoiceSession({
    transport: input.transport,
    ...(input.roomId ? { roomId: input.roomId } : {}),
    ...(input.now ? { now: input.now } : {}),
    onInterim: (text) => {
      if (!discarded) input.onInterim?.(text);
    },
    onFinal: (final, latency) => {
      if (discarded) return;
      if (expected <= 0) return; // A final for a segment this stream never closed.
      expected--;
      input.onSegment(final.text, latency);
    },
    onError: (code) => {
      if (discarded) return;
      if (code === "ASR_FAILED") {
        if (expected > 0) {
          expected--;
          input.onSegment(null);
        }
        return;
      }
      const outstanding = expected;
      expected = 0;
      for (let index = 0; index < outstanding; index++) input.onSegment(null);
      input.onFatal?.(code);
    },
  });
  const closeSegment = (at: number) => {
    if (!open) return false;
    open = false;
    expected++;
    input.onSpeechEnd?.(at);
    return true;
  };
  return {
    sessionId: session.sessionId,
    /** True while a VAD segment is open. */
    speaking: () => open,
    /** Frames and VAD edges from the capture, in capture order. */
    accept(frames: readonly LiveAudioFrame[], vad: readonly LiveVadEdge[]) {
      if (finished) return Promise.resolve();
      const limit = cut;
      const kept =
        limit === undefined
          ? frames
          : frames.filter((frame) => frame.timestamp <= limit);
      const edges: LiveVadEdge[] = [];
      for (const edge of vad) {
        if (limit !== undefined && edge.timestampMs > limit) continue;
        if (edge.type === "speech-start") {
          if (open) continue;
          open = true;
          edges.push(edge);
          input.onSpeechStart?.(edge.timestampMs);
        } else if (closeSegment(edge.timestampMs)) edges.push(edge);
      }
      if (!kept.length && !edges.length) return Promise.resolve();
      return session.push(kept, edges);
    },
    /** The user stopped at `at` (epoch ms, the frames' clock). Later audio is never forwarded. */
    cutoff(at: number) {
      if (cut === undefined || at < cut) cut = at;
    },
    /** After the capture stopped: finalize audio up to the cutoff and release the agent session. */
    async close() {
      if (finished) return;
      finished = true;
      const at = cut ?? Date.now();
      if (closeSegment(at)) await session.endTurn(at);
      await session.close().catch(() => {});
      for (; expected > 0 && !discarded; expected--) input.onSegment(null);
    },
    /** Discard everything: no further results; the agent session is released. */
    cancel() {
      if (discarded) return;
      discarded = true;
      finished = true;
      open = false;
      expected = 0;
      // Releasing the agent session finalizes nothing anyone will read.
      void session
        .close()
        .catch(() => {})
        .finally(() => session.dispose());
    },
  };
}
export type LiveSegmentStream = ReturnType<typeof createLiveSegmentStream>;

/**
 * One open microphone capture with VAD and its agent live ASR session, as a host opens it (for
 * example a native plugin that runs VAD in the app process). The host owns the microphone,
 * transport and owner fence; the adapters below give it the assistant listen port and dictation.
 */
export interface LiveCaptureStream {
  readonly startedAt: number;
  /** The platform echo canceller is active on this capture. */
  readonly echoCancelled: boolean;
  speaking(): boolean;
  /** Stop at `at` and finalize: results for audio up to `at` arrive before this resolves. */
  close(at?: number): Promise<{ durationMs: number }>;
  /** Stop now and discard. */
  cancel(): Promise<void>;
}
export interface LiveCaptureOpenOptions {
  signal: AbortSignal;
  /** Platform echo cancellation for full-duplex use (the assistant listens while it speaks). */
  echoCancel: boolean;
  roomId?: string;
  onSpeechStart?(atMs: number): void;
  onSpeechEnd?(atMs: number): void;
  onSegment(text: string | null, latency?: LiveVoiceLatency): void;
  onInterim?(text: string): void;
  onLevel?(peak: number): void;
  /** The capture or the agent route failed or stopped without being asked to. */
  onLost(error: unknown): void;
}
export type LiveCaptureOpener = (
  input: LiveCaptureOpenOptions,
) => Promise<LiveCaptureStream>;

/**
 * The voice assistant's listen port over a host's live capture, always echo-cancelled. Voice may
 * interrupt playback (`fullDuplex`) only when the device cancels its own speaker.
 */
export function liveAssistantListener(
  open: LiveCaptureOpener,
  options: {
    roomId?: string;
    onInterim?: (text: string) => void;
    onLatency?: (latency: LiveVoiceLatency) => void;
  } = {},
) {
  return async (
    handlers: AssistantListenHandlers,
  ): Promise<AssistantCapture> => {
    const capture = await open({
      signal: handlers.signal,
      echoCancel: true,
      ...(options.roomId ? { roomId: options.roomId } : {}),
      onSpeechStart: handlers.onSpeechStart,
      onSpeechEnd: handlers.onSpeechEnd,
      onSegment: (text, latency) => {
        if (latency) options.onLatency?.(latency);
        handlers.onSegment(text);
      },
      onInterim: (text) => options.onInterim?.(text),
      onLevel: (peak) => handlers.onLevel?.(peak),
      onLost: (error) => handlers.onEnd(error),
    });
    return {
      fullDuplex: capture.echoCancelled,
      close: async () => {
        await capture.close();
      },
      cancel: () => capture.cancel(),
    };
  };
}

export type LiveDictationClip = { recordingId: string; durationMs: number };
/**
 * Dictation (Transcribe) over a host's live capture, shaped like a recorder driver: Stop finalizes
 * exactly the audio up to Stop and the transcript is ready when Stop resolves; Cancel discards
 * everything. The text only ever becomes an editable draft; nothing is sent. A lost capture or the
 * duration limit reports a clip through `recordingStopped` (`durationMs` NaN when lost).
 */
export function createLiveDictation(
  open: LiveCaptureOpener,
  options: {
    roomId?: string;
    onInterim?: (text: string) => void;
    onLatency?: (latency: LiveVoiceLatency) => void;
    maxDurationMs?: number;
  } = {},
) {
  const maxDurationMs = Math.max(
    1000,
    Math.min(options.maxDurationMs ?? 300_000, 600_000),
  );
  type Recording = {
    id: string;
    capture?: LiveCaptureStream;
    controller: AbortController;
    texts: string[];
    clip?: LiveDictationClip;
    timer?: ReturnType<typeof setTimeout>;
    stopping?: Promise<LiveDictationClip>;
  };
  let recording: Recording | undefined;
  const listeners = new Set<(clip: LiveDictationClip) => void>();
  const emit = (clip: LiveDictationClip) => {
    for (const listener of [...listeners]) listener(clip);
  };
  const finish = (current: Recording, at?: number) => {
    current.stopping ??= (async () => {
      if (current.timer) clearTimeout(current.timer);
      const capture = current.capture as LiveCaptureStream;
      let result: { durationMs: number };
      try {
        result = await capture.close(at);
      } catch (error) {
        // An unconfirmed finalize leaves no transcript to trust: release the recording so
        // Transcribe can start again, and discard whatever the host still holds.
        if (recording === current) recording = undefined;
        current.texts.length = 0;
        await capture.cancel().catch(() => {});
        throw error;
      }
      const clip = { recordingId: current.id, durationMs: result.durationMs };
      current.clip = clip;
      return clip;
    })();
    return current.stopping;
  };
  return {
    live: true as const,
    async startRecording(): Promise<{
      recordingId: string;
      maxDurationMs: number;
    }> {
      if (recording && !recording.clip)
        throw Error("A transcription is already recording.");
      const current: Recording = {
        id: `live:${crypto.randomUUID()}`,
        controller: new AbortController(),
        texts: [],
      };
      recording = current;
      const owned = () => recording === current;
      let capture: LiveCaptureStream;
      try {
        capture = await open({
          signal: current.controller.signal,
          echoCancel: false,
          ...(options.roomId ? { roomId: options.roomId } : {}),
          onSegment: (text, latency) => {
            if (!owned()) return;
            if (latency) options.onLatency?.(latency);
            if (text) current.texts.push(text);
          },
          onInterim: (text) => {
            if (owned()) options.onInterim?.(text);
          },
          onLost: () => {
            if (!owned() || current.stopping) return;
            if (current.timer) clearTimeout(current.timer);
            current.controller.abort();
            // A lost capture leaves nothing to stop or transcribe; Transcribe can start again.
            recording = undefined;
            current.texts.length = 0;
            emit({ recordingId: current.id, durationMs: Number.NaN });
          },
        });
      } catch (error) {
        if (owned()) recording = undefined;
        throw error;
      }
      current.capture = capture;
      if (!owned()) {
        await capture.cancel();
        throw new DOMException("Transcription cancelled", "AbortError");
      }
      current.timer = setTimeout(() => {
        if (owned() && !current.stopping)
          void finish(current).then(emit, () =>
            emit({ recordingId: current.id, durationMs: Number.NaN }),
          );
      }, maxDurationMs);
      return { recordingId: current.id, maxDurationMs };
    },
    /** Stop at this moment. Audio captured after the tap is never transcribed. */
    async stopRecording(): Promise<LiveDictationClip> {
      const current = recording;
      const at = Date.now();
      if (!current?.capture) throw Error("No transcription is recording.");
      return finish(current, at);
    },
    /** The transcript of a stopped recording ('' is reported as no speech). */
    async transcribe(
      recordingId: string,
      signal: AbortSignal,
    ): Promise<{ text: string; local: true }> {
      signal.throwIfAborted();
      const current = recording;
      if (!current || current.id !== recordingId || !current.stopping)
        throw Error("This transcription is no longer available.");
      await current.stopping;
      signal.throwIfAborted();
      if (recording !== current)
        throw new DOMException("Transcription cancelled", "AbortError");
      const text = current.texts.join(" ").replace(/\s+/g, " ").trim();
      if (!text)
        throw Object.assign(Error("No speech was detected."), {
          code: "no-speech",
        });
      return { text, local: true };
    },
    async cancelRecording() {
      const current = recording;
      recording = undefined;
      if (!current) return;
      if (current.timer) clearTimeout(current.timer);
      current.controller.abort();
      current.texts.length = 0;
      await current.capture?.cancel();
    },
    /** Transcription completes with Stop; nothing is pending. */
    async cancel(_input: { requestId: string }) {},
    async addListener(
      _event: "recordingStopped",
      callback: (clip: LiveDictationClip) => void,
    ): Promise<{ remove(): Promise<void> }> {
      listeners.add(callback);
      return {
        remove: async () => {
          listeners.delete(callback);
        },
      };
    },
  };
}
export type LiveDictation = ReturnType<typeof createLiveDictation>;
