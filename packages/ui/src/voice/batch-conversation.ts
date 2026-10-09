import {
  buildVoiceTurnSignal,
  type ShouldRespondContext,
  shouldRespondToVoiceTurn,
  type VoiceTurnSignal,
} from "@elizaos/voice/turn";
import { TurnAggregator, type TurnAggregatorOptions } from "./end-of-turn";
import {
  isTtsEchoGateActive,
  markTtsPlaybackEnded,
  markTtsPlaybackStarted,
} from "./tts-playback-activity";
import {
  createVoiceActivityDetector,
  type VoiceActivityDetector,
  type VoiceActivityMetrics,
  type VoiceActivityOptions,
} from "./voice-activity";
import { toSpeakableText } from "./voice-chat-playback";

/** The same semantic/echo gate used by the OG converse surface and injected hosts. */
export function createVoiceTurnAggregator(
  options: Omit<TurnAggregatorOptions, "onCommit"> & {
    responseContext: () => ShouldRespondContext;
    onCommit: (text: string, signal: VoiceTurnSignal) => void;
  },
) {
  return new TurnAggregator({
    ...options,
    onCommit: (text) => {
      const context = options.responseContext();
      if (shouldRespondToVoiceTurn(text, context))
        options.onCommit(text, buildVoiceTurnSignal(text, context));
    },
  });
}
export type BatchVoicePhase =
  | "idle"
  | "starting"
  | "listening"
  | "transcribing"
  | "thinking"
  | "preparing-speech"
  | "speaking"
  | "error";
export interface BatchVoiceState {
  phase: BatchVoicePhase;
  transcript?: string;
  replyId?: string;
  error?: unknown;
}
export interface BatchVoiceCapture<Clip> {
  stop(): Promise<Clip>;
  cancel(): Promise<void> | void;
}
export interface BatchVoiceReply {
  requestId: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  text: string;
  complete: boolean;
  interrupted?: boolean;
}
export interface BatchVoicePorts<Clip> {
  /** Canonical room established by the host before opening the microphone. */
  readonly conversationId: string;
  /** Must reject hidden, retired, changed account/session/room/context or draft/edit bindings. */
  assertCurrent(): void;
  capture(input: {
    signal: AbortSignal;
    onActivity: (metrics: VoiceActivityMetrics) => void;
    onEnd: (error?: unknown) => void;
  }): Promise<BatchVoiceCapture<Clip>>;
  transcribe(clip: Clip, signal: AbortSignal): Promise<string>;
  /** Sends only this utterance as VOICE_DM, preserving its exact requestId. No composer path. */
  send(input: {
    turnId: string;
    text: string;
    voiceTurnSignal: VoiceTurnSignal;
    signal: AbortSignal;
  }): Promise<BatchVoiceReply>;
  /** Settles after matching completion and media cleanup (also on abort/failure). Raw play-start promises are insufficient. */
  speak(input: {
    turnId: string;
    replyId: string;
    text: string;
    signal: AbortSignal;
    onStarted: () => void;
  }): Promise<void>;
  onState?: (state: BatchVoiceState) => void;
}
export interface BatchVoiceClock {
  now: () => number;
  setTimer: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer: (handle: ReturnType<typeof setTimeout>) => void;
}
export interface BatchVoiceOptions {
  clock?: BatchVoiceClock;
  activity?: VoiceActivityOptions;
  captureTimeoutMs?: number;
  rearmMs?: number;
  postSpeechCooldownMs?: number;
  maxHoldMs?: number;
}
export class BatchVoiceError extends Error {
  constructor(
    readonly code: "binding" | "capture" | "reply" | "speech",
    message: string,
  ) {
    super(message);
    this.name = "BatchVoiceError";
  }
}
const cancelled = () =>
  new DOMException("Voice conversation stopped", "AbortError");
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => {});
  return { promise, resolve, reject };
}
type Committed = { text: string; signal: VoiceTurnSignal };
interface Session<Clip> {
  generation: number;
  controller: AbortController;
  ready: ReturnType<typeof deferred<void>>;
  capture?: BatchVoiceCapture<Clip>;
  pendingCapture?: Promise<BatchVoiceCapture<Clip>>;
  pendingSpeech?: Promise<void>;
  spokenText?: string;
  aggregator: TurnAggregator;
  committed: ReturnType<typeof deferred<Committed>>;
  hasCommit: boolean;
  replyIds: Set<string>;
}

/** Provider-free batch loop. Hosts own microphone, credentials, transport and real playback. */
export class BatchVoiceConversation<Clip> {
  private readonly conversationId: string;
  private generation = 0;
  private session?: Session<Clip>;
  private drain: Promise<void> = Promise.resolve();
  private state: BatchVoiceState = { phase: "idle" };
  private readonly clock: BatchVoiceClock;
  private readonly options: Required<
    Omit<BatchVoiceOptions, "clock" | "activity">
  > & { activity: VoiceActivityOptions };
  private readonly cancellations = new WeakMap<
    BatchVoiceCapture<Clip>,
    Promise<void>
  >();
  private lastSpoken = { text: "", at: Number.NEGATIVE_INFINITY };
  constructor(
    private readonly ports: BatchVoicePorts<Clip>,
    options: BatchVoiceOptions = {},
  ) {
    this.clock = options.clock ?? {
      now: () => Date.now(),
      setTimer: (callback, ms) => setTimeout(callback, ms),
      clearTimer: (handle) => clearTimeout(handle),
    };
    this.options = {
      activity: options.activity ?? {},
      captureTimeoutMs: options.captureTimeoutMs ?? 59000,
      rearmMs: options.rearmMs ?? 250,
      postSpeechCooldownMs: options.postSpeechCooldownMs ?? 1500,
      maxHoldMs: options.maxHoldMs ?? 3500,
    };
    this.conversationId = ports.conversationId;
    if (!this.conversationId.trim())
      throw new BatchVoiceError(
        "binding",
        "A current conversation is required.",
      );
    for (const value of [
      this.options.captureTimeoutMs,
      this.options.rearmMs,
      this.options.postSpeechCooldownMs,
      this.options.maxHoldMs,
    ])
      if (!Number.isFinite(value) || value < 0)
        throw new RangeError("Invalid voice timing policy");
    if (
      this.options.captureTimeoutMs < 1 ||
      this.options.captureTimeoutMs > 59000
    )
      throw new RangeError("Invalid capture duration");
  }
  getSnapshot(): BatchVoiceState {
    return { ...this.state };
  }
  private publish(state: BatchVoiceState) {
    this.state = state;
    this.ports.onState?.({ ...state });
  }
  private current(session: Session<Clip>) {
    return (
      this.session === session &&
      session.generation === this.generation &&
      !session.controller.signal.aborted
    );
  }
  private check(session: Session<Clip>) {
    if (!this.current(session)) throw cancelled();
    this.ports.assertCurrent();
  }
  private async wait<T>(
    promise: Promise<T>,
    session: Session<Clip>,
  ): Promise<T> {
    this.check(session);
    const signal = session.controller.signal;
    let abort!: () => void;
    const interrupted = new Promise<never>((_, reject) => {
      abort = () => reject(signal.reason ?? cancelled());
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    try {
      const result = await Promise.race([promise, interrupted]);
      this.check(session);
      return result;
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }
  private cancelCapture(capture: BatchVoiceCapture<Clip>) {
    let pending = this.cancellations.get(capture);
    if (!pending) {
      pending = Promise.resolve().then(() => capture.cancel());
      this.cancellations.set(capture, pending);
    }
    return pending;
  }
  private responseContext(): ShouldRespondContext {
    return {
      recentAgentReply: this.lastSpoken.text,
      replyAgeMs: Math.max(0, this.clock.now() - this.lastSpoken.at),
      agentSpeaking: this.state.phase === "speaking",
    };
  }
  async start(): Promise<void> {
    if (this.session) return this.session.ready.promise;
    this.ports.assertCurrent();
    const session: Session<Clip> = {
      generation: ++this.generation,
      controller: new AbortController(),
      ready: deferred<void>(),
      committed: deferred<Committed>(),
      hasCommit: false,
      replyIds: new Set(),
      aggregator: createVoiceTurnAggregator({
        maxHoldMs: this.options.maxHoldMs,
        setTimer: this.clock.setTimer,
        clearTimer: this.clock.clearTimer,
        responseContext: () => this.responseContext(),
        onCommit: (text, signal) => {
          if (this.current(session)) {
            session.hasCommit = true;
            session.committed.resolve({ text, signal });
          }
        },
      }),
    };
    this.session = session;
    this.publish({ phase: "starting" });
    void this.run(session).catch(async (error) => {
      session.ready.reject(error);
      if (!this.current(session)) return;
      try {
        await this.retire(session);
      } catch (cleanup) {
        error = cleanup;
      }
      if (session.generation + 1 === this.generation && !this.session)
        this.publish({ phase: "error", error });
    });
    return session.ready.promise;
  }
  /** Called by host lifecycle/account subscriptions; no automatic restart on return. */
  recheck() {
    const session = this.session;
    if (!session) return;
    try {
      this.check(session);
    } catch {
      void this.stop().catch((error) => {
        if (!this.session) this.publish({ phase: "error", error });
      });
    }
  }
  async stop(): Promise<void> {
    const session = this.session;
    if (session) await this.retire(session);
    else await this.drain;
  }
  private retire(session: Session<Clip>): Promise<void> {
    if (this.session !== session) return this.drain;
    this.session = undefined;
    ++this.generation;
    session.controller.abort(cancelled());
    session.ready.reject(cancelled());
    session.aggregator.dispose();
    const pending = session.pendingCapture;
    const cleanup = async () => {
      const captureCleanup = async () => {
        const capture =
          session.capture ??
          (pending ? await pending.catch(() => undefined) : undefined);
        if (capture) await this.cancelCapture(capture);
      };
      await Promise.all([
        captureCleanup(),
        session.pendingSpeech?.catch(() => {}),
      ]);
      if (session.spokenText)
        this.lastSpoken = { text: session.spokenText, at: this.clock.now() };
    };
    this.drain = Promise.all([this.drain, cleanup()]).then(() => {});
    void this.drain.catch(() => {});
    this.publish({ phase: "idle" });
    return this.drain;
  }
  private async pause(session: Session<Clip>) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await this.wait(
        new Promise<void>((resolve) => {
          timer = this.clock.setTimer(resolve, this.options.rearmMs);
        }),
        session,
      );
    } finally {
      if (timer !== undefined) this.clock.clearTimer(timer);
    }
  }
  private async capture(session: Session<Clip>): Promise<string | null> {
    this.check(session);
    const end = deferred<void>();
    let detector: VoiceActivityDetector | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const activity = (metrics: VoiceActivityMetrics) => {
      if (!this.current(session)) return;
      try {
        this.check(session);
        if (
          !Number.isFinite(metrics.peak) ||
          metrics.peak < 0 ||
          metrics.peak > 1 ||
          (metrics.rms !== undefined &&
            (!Number.isFinite(metrics.rms) ||
              metrics.rms < 0 ||
              metrics.rms > 1))
        )
          throw new BatchVoiceError("capture", "Invalid microphone activity");
        if (detector?.(metrics).shouldStop) end.resolve();
      } catch (error) {
        end.reject(error);
      }
    };
    const pending = Promise.resolve().then(() => {
      this.check(session);
      return this.ports.capture({
        signal: session.controller.signal,
        onActivity: activity,
        onEnd: (error) => {
          if (this.current(session)) {
            if (error !== undefined) end.reject(error);
            else end.resolve();
          }
        },
      });
    });
    session.pendingCapture = pending;
    void pending.catch(() => {});
    try {
      const capture = await this.wait(pending, session);
      this.check(session);
      session.pendingCapture = undefined;
      session.capture = capture;
      // Permission/acquisition time is not microphone grace time.
      detector = createVoiceActivityDetector(
        {
          ...this.options.activity,
          isTtsEchoGateActive: (at) =>
            (this.options.activity.isTtsEchoGateActive?.(at) ?? false) ||
            isTtsEchoGateActive() ||
            at - this.lastSpoken.at <= this.options.postSpeechCooldownMs,
        },
        this.clock.now(),
        this.clock.now,
      );
      this.publish({ phase: "listening" });
      this.check(session);
      session.ready.resolve();
      timer = this.clock.setTimer(
        () => end.resolve(),
        this.options.captureTimeoutMs,
      );
      await this.wait(
        Promise.race([end.promise, session.committed.promise.then(() => {})]),
        session,
      );
      this.check(session);
      if (timer !== undefined) {
        this.clock.clearTimer(timer);
        timer = undefined;
      }
      if (!detector.hasSpeech) {
        await this.wait(this.cancelCapture(capture), session);
        session.capture = undefined;
        return null;
      }
      this.publish({ phase: "transcribing" });
      this.check(session);
      const clip = await this.wait(capture.stop(), session);
      this.check(session);
      const text = await this.wait(
        this.ports.transcribe(clip, session.controller.signal),
        session,
      );
      this.check(session);
      await this.wait(this.cancelCapture(capture), session);
      this.check(session);
      session.capture = undefined;
      if (typeof text !== "string")
        throw new BatchVoiceError("capture", "Invalid Cloud transcript");
      return text.trim();
    } finally {
      if (timer !== undefined) this.clock.clearTimer(timer);
    }
  }
  private async run(session: Session<Clip>) {
    await this.wait(this.drain, session);
    this.check(session);
    while (this.current(session)) {
      const transcript = session.hasCommit ? null : await this.capture(session);
      this.check(session);
      if (transcript) {
        if (session.hasCommit) {
          const prior = await this.wait(session.committed.promise, session);
          this.check(session);
          session.committed = deferred<Committed>();
          session.hasCommit = false;
          session.aggregator.addFinal(`${prior.text} ${transcript}`);
        } else session.aggregator.addFinal(transcript);
      }
      if (!session.hasCommit) {
        await this.pause(session);
        continue;
      }
      const turn = await this.wait(session.committed.promise, session);
      this.check(session);
      session.committed = deferred<Committed>();
      session.hasCommit = false;
      const turnId = crypto.randomUUID();
      this.publish({ phase: "thinking", transcript: turn.text });
      this.check(session);
      const reply = await this.wait(
        this.ports.send({
          turnId,
          text: turn.text,
          voiceTurnSignal: turn.signal,
          signal: session.controller.signal,
        }),
        session,
      );
      this.check(session);
      if (
        reply.requestId !== turnId ||
        reply.conversationId !== this.conversationId ||
        !reply.userMessageId?.trim() ||
        !reply.assistantMessageId?.trim() ||
        reply.complete !== true ||
        reply.interrupted ||
        session.replyIds.has(reply.assistantMessageId) ||
        typeof reply.text !== "string"
      )
        throw new BatchVoiceError(
          "reply",
          "The voice reply was not confirmed for this turn.",
        );
      session.replyIds.add(reply.assistantMessageId);
      const text = toSpeakableText(reply.text);
      if (text) {
        this.publish({
          phase: "preparing-speech",
          replyId: reply.assistantMessageId,
        });
        this.check(session);
        let playbackStarted = false;
        const playback = Promise.resolve().then(() => {
          this.check(session);
          return this.ports.speak({
            turnId,
            replyId: reply.assistantMessageId,
            text,
            signal: session.controller.signal,
            onStarted: () => {
              if (!this.current(session)) return;
              try {
                this.check(session);
                if (!playbackStarted) markTtsPlaybackStarted();
                playbackStarted = true;
                session.spokenText = text;
                this.publish({
                  phase: "speaking",
                  replyId: reply.assistantMessageId,
                });
              } catch {
                void this.stop().catch((error) => {
                  if (!this.session) this.publish({ phase: "error", error });
                });
              }
            },
          });
        });
        const ownedPlayback = playback.finally(() => {
          if (playbackStarted) markTtsPlaybackEnded();
        });
        session.pendingSpeech = ownedPlayback;
        void ownedPlayback.catch(() => {});
        await this.wait(ownedPlayback, session);
        this.check(session);
        if (!playbackStarted)
          throw new BatchVoiceError("speech", "Voice playback did not start.");
        this.lastSpoken = { text, at: this.clock.now() };
        session.pendingSpeech = undefined;
        session.spokenText = undefined;
      }
      await this.pause(session);
    }
  }
}
