/**
 * Voice conversation turn controller: a spoken turn goes to the agent and the reply is spoken
 * back, with speech-driven endpointing, barge-in and heard-content accounting. Dictation (an
 * editable draft the user sends) is a separate host flow and never uses this controller.
 *
 * One continuous capture stays open for the whole conversation (for example a native VAD stream
 * feeding on-device streaming ASR). Every VAD segment yields one final transcript. The controller
 * joins the segments of one utterance and decides when the user has finished:
 *
 *  - After the last segment closes and its final is in, a short gap (`shortGapMs`) asks the
 *    optional semantic `endpoint` port (for example the local-inference end-of-turn route) with a
 *    bounded deadline, one call in flight per utterance. `finished` submits now. `continue`
 *    (scored, not complete), `unavailable`, a failure or an expired deadline all leave the
 *    decision to the long gap: unavailable is never complete.
 *  - A long gap (`longGapMs`) always submits. Both gaps are measured from the VAD speech-end.
 *  - New speech before submission cancels both timers (and any pending endpoint call) and the
 *    utterance continues.
 *  - Each submission reports which path took it (`semantic` or `gap`) and the last semantic
 *    outcome of that utterance through `onTurn` (diagnostics: enums and numbers, never text).
 *
 * Generations: each submission and each interruption bumps `turn`. Every asynchronous callback
 * (endpoint decision, agent reply, playback progress) checks the generation it started under and
 * is dropped when it has changed. The controller never resubmits a turn it already handed to
 * `send`: speech after submission interrupts the in-flight reply or playback and becomes the
 * next turn, so the earlier turn is never committed twice.
 *
 * Barge-in and heard content: speech that starts while a reply is pending or playing is tentative.
 * While the request is pending it interrupts once the VAD segment has stayed open for
 * `bargeInConfirmMs` or its transcript passes the disfluency/echo gate; while the reply plays only
 * the transcript gate confirms (residual echo can hold the VAD open for a whole sentence). A cough,
 * a blip or the reply's own echo (rejected by the gate) leaves the reply running. While a reply
 * plays, voice can interrupt only over a capture that reports active echo cancellation
 * (`fullDuplex`); otherwise speech during playback is ignored and an explicit stop remains.
 * Interrupting aborts the reply (the request and playback are cancelled through the port's
 * AbortSignal). Replies are played one sentence at a time; only sentences whose playback
 * completed count as heard. The sentence playing when the user interrupted is reported as
 * unheard: playback reports completion per utterance, not a position, so a partial sentence is
 * never claimed as spoken. `onHeard` reports the heard/unheard split for the host to keep in
 * conversation state.
 *
 * Side effects: an automatic voice submission is never approval. A reply that carries action
 * proposals ends the voice session (the host shows the review); an owner-input pause waits for
 * the host to deliver the separately approved result through `resume`.
 *
 * Pure module (no Capacitor, DOM, storage or network imports): hosts supply every port.
 */

import { randomId } from "./random-id.js";

export type AssistantPhase =
  | "idle"
  | "starting"
  | "listening"
  | "thinking"
  | "awaiting-user-input"
  | "speaking"
  | "error";
export type AssistantAwaitingInput = {
  proposalId: string;
  digest: string;
  requestId: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
};
export interface AssistantState {
  phase: AssistantPhase;
  /** The user is speaking now (a VAD segment is open). */
  hearing?: boolean;
  /** An utterance is waiting for the endpoint gap before it is sent. */
  pendingText?: string;
  muted?: boolean;
  transcript?: string;
  replyId?: string;
  error?: unknown;
  awaitingUserInput?: AssistantAwaitingInput;
}
export interface AssistantReply {
  requestId: string;
  conversationId: string;
  userMessageId: string;
  assistantMessageId: string;
  text: string;
  complete: boolean;
  interrupted?: boolean;
  awaitingUserInput?: { proposalId: string; digest: string };
}
/** `finished`: the turn is complete. `continue`: scored as not complete. `unavailable`: not scored. */
export type EndpointDecision = "finished" | "continue" | "unavailable";
/** A decision with diagnostic detail (enum reason and scorer latency only, never text). */
export interface EndpointResult {
  decision: EndpointDecision;
  reason?: string;
  latencyMs?: number;
}
/** What the semantic endpoint said for the utterance that was submitted. */
export type EndpointOutcome =
  | "complete"
  | "incomplete"
  | "unavailable"
  | "timeout"
  | "error"
  | "not-asked";
export interface EndpointRecord {
  /** The path that submitted the turn. */
  by: "semantic" | "gap";
  semantic: EndpointOutcome;
  /** The scorer's reason when it was unavailable (an upstream enum value). */
  reason?: string;
  /** Scorer latency reported by the agent, or the client round trip when it gave none. */
  latencyMs?: number;
}
export interface AssistantHeard {
  turnId: string;
  replyId: string;
  /** Sentences whose playback completed, in order. */
  heard: string;
  /** Everything not played to the end, including the sentence that was interrupted. */
  unheard: string;
  interrupted: boolean;
}
export interface AssistantCapture {
  /** Finalize: segments closed by this call still deliver their final before it resolves. */
  close(): Promise<void>;
  /** Discard: no further segment results are delivered. */
  cancel(): void | Promise<void>;
  /** The capture cancels the device's own playback (platform echo canceller active). */
  readonly fullDuplex?: boolean;
}
export interface AssistantListenHandlers {
  signal: AbortSignal;
  onSpeechStart(atMs: number): void;
  onSpeechEnd(atMs: number): void;
  /** One result per closed segment, in order; null when the segment produced no transcript. */
  onSegment(text: string | null): void;
  /** The capture ended by itself (microphone lost, transport failure). */
  onEnd(error?: unknown): void;
  /** Microphone level in [0, 1], display only. */
  onLevel?(peak: number): void;
}
export interface AssistantPorts {
  readonly conversationId: string;
  /** Throws when the owner, account, agent session, view or draft binding changed. */
  assertCurrent(): void;
  listen(handlers: AssistantListenHandlers): Promise<AssistantCapture>;
  /** A new utterance began: the host pins the context the turn will be sent with. Throws when stale. */
  beginUtterance?(): void;
  /** Semantic end-of-turn (for example the local end-of-turn scorer). Omitted: the VAD long-gap fallback decides alone. */
  endpoint?(
    text: string,
    signal: AbortSignal,
  ): Promise<EndpointDecision | EndpointResult>;
  /** Disfluency and self-echo gate for one segment (upstream shouldRespondToVoiceTurn). */
  shouldRespond?(
    text: string,
    context: {
      recentAgentReply: string;
      replyAgeMs: number;
      agentSpeaking: boolean;
    },
  ): boolean;
  /** Turn signal metadata for the agent (upstream buildVoiceTurnSignal). */
  turnSignal?(text: string): unknown;
  send(input: {
    turnId: string;
    text: string;
    voiceTurnSignal: unknown;
    signal: AbortSignal;
  }): Promise<AssistantReply>;
  /** Text the speaker can say ('' to stay silent). */
  speakable?(text: string): string;
  /** Plays one sentence; settles after its playback ended (or rejects when aborted/failed). */
  speak(input: {
    turnId: string;
    replyId: string;
    text: string;
    signal: AbortSignal;
    onStarted: () => void;
  }): Promise<void>;
  onHeard?(heard: AssistantHeard): void;
  onState?(state: AssistantState): void;
  /** Microphone level in [0, 1], display only. */
  onLevel?(peak: number): void;
  /** Diagnostics hooks: numbers, enums and ids only. `submitted` carries how the turn was endpointed. */
  onTurn?(
    event: "submitted" | "first-audio" | "finished" | "interrupted",
    turnId: string,
    detail?: { endpoint: EndpointRecord },
  ): void;
}
export interface AssistantTiming {
  shortGapMs: number;
  longGapMs: number;
  endpointDeadlineMs: number;
  /** Speech held this long while a request is pending (before playback) interrupts it before its transcript. */
  bargeInConfirmMs: number;
}
/**
 * Engineering defaults, not accepted measurements or product-set constants. Gaps follow the VAD
 * speech-end, which itself trails the last voiced window by the native gate's hangover (the
 * Android LiveVadGate, about 512 ms). The barge-in hold exceeds that hangover, so a short blip
 * (which keeps a segment open for about 550 ms) never confirms by time. The endpoint deadline
 * covers the IPC round trip and one scorer pass; short gap plus deadline (900 ms) stays well
 * under the long gap, which submits regardless.
 */
export const ASSISTANT_TIMING_DEFAULTS: AssistantTiming = Object.freeze({
  shortGapMs: 300,
  longGapMs: 1200,
  endpointDeadlineMs: 600,
  bargeInConfirmMs: 700,
});
export interface AssistantClock {
  now(): number;
  setTimer(callback: () => void, ms: number): unknown;
  clearTimer(handle: unknown): void;
}
const systemClock: AssistantClock = {
  now: () => Date.now(),
  setTimer: (callback, ms) => setTimeout(callback, ms),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class VoiceAssistantError extends Error {
  readonly code: "binding" | "capture" | "reply" | "speech";
  constructor(
    code: "binding" | "capture" | "reply" | "speech",
    message: string,
  ) {
    super(message);
    this.code = code;
    this.name = "VoiceAssistantError";
  }
}
const stopped = () => new DOMException("Voice assistant stopped", "AbortError");

/**
 * Split a reply into sentence-sized pieces for playback accounting. Joining the pieces with
 * single spaces gives the whitespace-collapsed reply back.
 */
export function splitSpokenSentences(text: string): string[] {
  const value = String(text || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!value) return [];
  const out: string[] = [];
  let rest = value;
  while (rest) {
    let boundary = -1;
    for (const match of rest.matchAll(/[.!?;:]["')\]]?\s/g)) {
      // Short fragments (initials, "Dr.") stay with the next words.
      const end = (match.index ?? -1) + match[0].length - 1;
      if (match.index !== undefined && end >= 20) {
        boundary = end;
        break;
      }
    }
    if (boundary < 0) {
      out.push(rest);
      break;
    }
    out.push(rest.slice(0, boundary).trim());
    rest = rest.slice(boundary).trim();
  }
  return out.filter(Boolean);
}

type Segment = {
  closed: boolean;
  done: boolean;
  text: string;
  /** Started while a reply was pending or playing: interrupts only once confirmed. */
  tentative?: Response;
  /** Started during playback over a capture without echo cancellation: never a turn. */
  ignored?: boolean;
};
type Response = {
  turnId: string;
  controller: AbortController;
  replyId?: string;
  sentences: string[];
  played: number;
  started: boolean;
};
/** Every sentence of the reply that has started playing: the echo the microphone may hear. */
const audible = (response: Response) =>
  response.started
    ? response.sentences.slice(0, response.played + 1).join(" ")
    : "";

/** One voice assistant conversation. Owned by the host's chat shell; stopped on any binding change. */
export class VoiceAssistantSession {
  private readonly timing: AssistantTiming;
  private readonly clock: AssistantClock;
  private session = 0;
  private turn = 0;
  private utteranceEpoch = 0;
  private active = false;
  private controller?: AbortController;
  private capture?: AssistantCapture;
  private opening?: Promise<AssistantCapture | undefined>;
  private closing: Promise<void> = Promise.resolve();
  private segments: Segment[] = [];
  private lastSpeechEndAt = 0;
  private shortTimer: unknown;
  private longTimer: unknown;
  private endpointController?: AbortController;
  /** The last semantic outcome of the current utterance (reset when speech resumes). */
  private endpointOutcome?: Omit<EndpointRecord, "by">;
  private response?: Response;
  private inflight: Promise<unknown> = Promise.resolve();
  private speech = new Set<Promise<unknown>>();
  private lastSpoken = { text: "", at: Number.NEGATIVE_INFINITY };
  private awaiting?: {
    pause: AssistantAwaitingInput;
    resolve: (reply: AssistantReply) => void;
    resolved: boolean;
  };
  private state: AssistantState = { phase: "idle" };
  private mutedValue = false;

  private readonly ports: AssistantPorts;
  constructor(
    ports: AssistantPorts,
    options: { timing?: Partial<AssistantTiming>; clock?: AssistantClock } = {},
  ) {
    this.ports = ports;
    const timing = { ...ASSISTANT_TIMING_DEFAULTS, ...options.timing };
    for (const value of Object.values(timing))
      if (!Number.isFinite(value) || value < 0)
        throw new RangeError("Invalid voice assistant timing");
    if (timing.longGapMs < timing.shortGapMs)
      throw new RangeError(
        "The long gap must not be shorter than the short gap",
      );
    this.timing = timing;
    this.clock = options.clock ?? systemClock;
    if (!ports.conversationId?.trim())
      throw new VoiceAssistantError(
        "binding",
        "A current conversation is required.",
      );
  }

  get muted() {
    return this.mutedValue;
  }
  getSnapshot(): AssistantState {
    return {
      ...this.state,
      ...(this.state.awaitingUserInput
        ? { awaitingUserInput: { ...this.state.awaitingUserInput } }
        : {}),
    };
  }

  private publish(state: AssistantState) {
    const { muted: _muted, ...rest } = state;
    this.state = { ...rest, ...(this.mutedValue ? { muted: true } : {}) };
    this.ports.onState?.(this.getSnapshot());
  }
  private listeningState(): AssistantState {
    const open = this.segments.some(
      (segment) => !segment.closed && !segment.ignored && !segment.tentative,
    );
    const text = this.utteranceText();
    return {
      phase: "listening",
      ...(open ? { hearing: true } : {}),
      ...(text ? { pendingText: text } : {}),
    };
  }
  /** The phase in progress, with mute and listening details refreshed. */
  private republish() {
    this.publish(this.response ? { ...this.state } : this.listeningState());
  }
  private current(session: number) {
    return this.active && this.session === session;
  }
  private check(session: number) {
    if (!this.current(session)) throw stopped();
    this.ports.assertCurrent();
  }

  async start(): Promise<void> {
    if (this.active) return;
    this.ports.assertCurrent();
    this.active = true;
    const session = ++this.session;
    this.controller = new AbortController();
    this.publish({ phase: "starting" });
    try {
      await this.open(session);
      this.check(session);
      this.publish(this.listeningState());
    } catch (error) {
      if (this.current(session)) await this.fail(session, error);
      throw error;
    }
  }

  /** Called on host lifecycle/account changes: a changed binding stops the conversation. */
  recheck() {
    if (!this.active) return;
    try {
      this.ports.assertCurrent();
    } catch {
      void this.stop();
    }
  }

  async stop(): Promise<void> {
    if (!this.active) {
      await Promise.all([this.drainSpeech(), this.closing]);
      return;
    }
    this.active = false;
    ++this.session;
    ++this.turn;
    ++this.utteranceEpoch;
    this.controller?.abort(stopped());
    this.clearTimers();
    this.endpointController?.abort();
    const response = this.response;
    this.response = undefined;
    if (response) {
      response.controller.abort(stopped());
      this.reportInterrupted(response);
    }
    this.awaiting = undefined;
    this.segments = [];
    const capture = this.capture,
      opening = this.opening;
    this.capture = undefined;
    this.opening = undefined;
    this.publish({ phase: "idle" });
    // Discard: an utterance that was not submitted is not sent after Stop, including a muted
    // capture that is still finalizing.
    for (const closing of this.closingCaptures)
      void Promise.resolve(closing.cancel()).catch(() => {});
    await Promise.all([
      Promise.resolve(capture?.cancel()).catch(() => {}),
      opening?.then((late) => late?.cancel()).catch(() => {}),
      this.closing,
      this.drainSpeech(),
    ]);
  }

  /**
   * Microphone off/on. Muting finalizes speech up to now (also a capture that is still opening);
   * the reply in progress continues. Unmuting waits until the muted capture has finished closing.
   */
  async setMuted(muted: boolean): Promise<void> {
    if (!this.active || muted === this.mutedValue) return;
    const session = this.session;
    this.mutedValue = muted;
    if (muted) {
      const capture = this.capture,
        opening = this.opening;
      this.capture = undefined;
      this.republish();
      if (capture) this.closeCapture(capture);
      // A capture still opening is closed by open() as soon as it arrives.
      await opening?.catch(() => {});
      await this.closing;
      if (this.current(session)) this.schedule();
      return;
    }
    if (this.state.phase === "awaiting-user-input") {
      this.republish();
      return;
    }
    try {
      await this.open(session);
      this.check(session);
      if (!this.mutedValue) this.republish();
    } catch (error) {
      if (this.current(session)) await this.fail(session, error);
    }
  }

  /** Stop speaking now (the accessible counterpart of barge-in). Returns true when a reply was cut. */
  interruptSpeech(): boolean {
    const response = this.response;
    if (!this.active || !response?.started) return false;
    this.interrupt();
    this.publish(this.listeningState());
    return true;
  }

  /** Deliver the separately approved result of the paused turn. No send or approval happens here. */
  resume(input: {
    pause: AssistantAwaitingInput;
    reply: AssistantReply;
  }): boolean {
    const held = this.awaiting;
    if (
      !this.active ||
      !held ||
      held.resolved ||
      !input ||
      typeof input !== "object"
    )
      return false;
    try {
      this.ports.assertCurrent();
    } catch {
      this.recheck();
      return false;
    }
    const { pause, reply } = input,
      original = held.pause;
    if (
      !pause ||
      !reply ||
      pause.proposalId !== original.proposalId ||
      pause.digest !== original.digest ||
      pause.requestId !== original.requestId ||
      pause.conversationId !== original.conversationId ||
      pause.userMessageId !== original.userMessageId ||
      pause.assistantMessageId !== original.assistantMessageId ||
      reply.requestId !== original.requestId ||
      reply.conversationId !== original.conversationId ||
      reply.userMessageId !== original.userMessageId ||
      typeof reply.assistantMessageId !== "string" ||
      !reply.assistantMessageId.trim() ||
      reply.assistantMessageId === original.assistantMessageId ||
      reply.complete !== true ||
      reply.interrupted ||
      reply.awaitingUserInput !== undefined ||
      typeof reply.text !== "string"
    )
      return false;
    held.resolved = true;
    held.resolve({
      requestId: reply.requestId,
      conversationId: reply.conversationId,
      userMessageId: reply.userMessageId,
      assistantMessageId: reply.assistantMessageId,
      text: reply.text,
      complete: true,
    });
    return true;
  }

  private closingCaptures = new Set<AssistantCapture>();
  private closeCapture(capture: AssistantCapture) {
    this.closingCaptures.add(capture);
    const closed = Promise.resolve()
      .then(() => capture.close())
      .catch(() => {})
      .finally(() => this.closingCaptures.delete(capture));
    this.closing = Promise.all([this.closing, closed]).then(() => {});
  }

  private async open(session: number) {
    if (this.capture || this.opening) return;
    // A muted capture's last segment is delivered before a new capture can open.
    await this.closing;
    this.check(session);
    // Never reopen during an owner-review pause; the pause reopens the microphone when it ends.
    if (
      this.capture ||
      this.opening ||
      this.mutedValue ||
      (this.awaiting && !this.awaiting.resolved)
    )
      return;
    const signal = this.controller?.signal;
    if (!signal) throw stopped();
    const pending = this.ports
      .listen({
        signal,
        onSpeechStart: (at) => {
          if (this.current(session) && !this.mutedValue) this.speechStarted(at);
        },
        onSpeechEnd: (at) => {
          if (this.current(session)) this.speechEnded(at);
        },
        onSegment: (text) => {
          if (this.current(session)) this.segmentResult(text);
        },
        onEnd: (error) => {
          if (this.current(session)) void this.captureEnded(session, error);
        },
        onLevel: (peak) => {
          if (this.current(session) && !this.mutedValue)
            this.ports.onLevel?.(peak);
        },
      })
      .then(
        (capture) => {
          if (this.opening !== pending || !this.current(session)) {
            void Promise.resolve(capture.cancel()).catch(() => {});
            return undefined;
          }
          this.opening = undefined;
          // Muted while the microphone was opening: it never stays on.
          if (this.mutedValue) {
            this.closeCapture(capture);
            return undefined;
          }
          this.capture = capture;
          return capture;
        },
        (error) => {
          if (this.opening === pending) this.opening = undefined;
          throw error;
        },
      );
    this.opening = pending;
    await pending;
  }

  private async captureEnded(session: number, error?: unknown) {
    this.capture = undefined;
    if (this.mutedValue) return;
    await this.fail(
      session,
      error ?? new VoiceAssistantError("capture", "The microphone stopped."),
    );
  }

  private async fail(session: number, error: unknown) {
    if (!this.current(session)) return;
    await this.stop();
    if (this.session === session + 1) this.publish({ phase: "error", error });
  }

  // --- Endpointing --------------------------------------------------------------------------

  private utteranceText() {
    return this.segments
      .filter(
        (segment) =>
          segment.done &&
          segment.text &&
          !segment.ignored &&
          !segment.tentative,
      )
      .map((segment) => segment.text)
      .join(" ")
      .trim();
  }
  private clearTimers() {
    if (this.shortTimer !== undefined) this.clock.clearTimer(this.shortTimer);
    if (this.longTimer !== undefined) this.clock.clearTimer(this.longTimer);
    this.shortTimer = this.longTimer = undefined;
  }

  private speechStarted(_at: number) {
    // Speech always wins over a racing timer or endpoint decision.
    ++this.utteranceEpoch;
    this.clearTimers();
    this.endpointController?.abort();
    this.endpointController = undefined;
    this.endpointOutcome = undefined;
    const response = this.response;
    if (response?.started && !this.capture?.fullDuplex) {
      // Without echo cancellation the microphone hears the reply: speech during playback is not a turn.
      this.segments.push({
        closed: false,
        done: false,
        text: "",
        ignored: true,
      });
      return;
    }
    if (
      !this.segments.some((segment) => !segment.ignored) &&
      this.ports.beginUtterance
    ) {
      try {
        this.ports.beginUtterance();
      } catch {
        void this.stop();
        return;
      }
    }
    const segment: Segment = {
      closed: false,
      done: false,
      text: "",
      ...(response ? { tentative: response } : {}),
    };
    this.segments.push(segment);
    if (response && !response.started) {
      const session = this.session;
      // Held speech interrupts a pending request before its transcript; a blip closes first and waits
      // for the gate. While the reply plays only the transcript gate confirms: residual echo of a
      // sentence can hold the VAD open longer than any fixed hold.
      this.clock.setTimer(() => {
        if (
          this.current(session) &&
          !segment.closed &&
          segment.tentative === response &&
          !response.started
        )
          this.confirmBargeIn(segment);
      }, this.timing.bargeInConfirmMs);
      return;
    }
    if (response) return;
    this.publish(this.listeningState());
  }

  private confirmBargeIn(segment: Segment) {
    const response = segment.tentative;
    delete segment.tentative;
    if (response && this.response === response) this.interrupt();
    this.publish(this.listeningState());
  }

  private speechEnded(at: number) {
    const open = this.segments.find((segment) => !segment.closed);
    if (!open) return;
    open.closed = true;
    if (!open.ignored)
      this.lastSpeechEndAt = Number.isFinite(at)
        ? Math.min(at, this.clock.now())
        : this.clock.now();
    this.republish();
    this.schedule();
  }

  private segmentResult(text: string | null) {
    const segment = this.segments.find((item) => item.closed && !item.done);
    if (!segment) return; // A result for a discarded utterance.
    segment.done = true;
    const value =
      !segment.ignored && typeof text === "string" ? text.trim() : "";
    if (value) {
      const playing = this.response?.started ? this.response : undefined;
      const context = {
        recentAgentReply: playing ? audible(playing) : this.lastSpoken.text,
        replyAgeMs: playing
          ? 0
          : Math.max(0, this.clock.now() - this.lastSpoken.at),
        agentSpeaking: !!playing,
      };
      if (!this.ports.shouldRespond || this.ports.shouldRespond(value, context))
        segment.text = value;
    }
    if (segment.tentative) {
      // An accepted transcript confirms the interruption; noise, filler or echo leaves the reply running.
      if (segment.text) this.confirmBargeIn(segment);
      else {
        delete segment.tentative;
        segment.ignored = true;
      }
    }
    this.republish();
    this.schedule();
  }

  private schedule() {
    if (!this.active || this.response) return;
    if (this.segments.some((segment) => !segment.closed || !segment.done))
      return;
    const text = this.utteranceText();
    if (!text) {
      this.segments = [];
      this.publish(this.listeningState());
      return;
    }
    this.clearTimers();
    const epoch = this.utteranceEpoch,
      session = this.session;
    const elapsed = Math.max(0, this.clock.now() - this.lastSpeechEndAt);
    const owns = () =>
      this.current(session) && this.utteranceEpoch === epoch && !this.response;
    if (this.ports.endpoint)
      this.shortTimer = this.clock.setTimer(
        () => {
          this.shortTimer = undefined;
          if (!owns()) return;
          // One endpoint call in flight per utterance: a re-scheduled gap replaces the earlier call.
          this.endpointController?.abort();
          const controller = new AbortController();
          this.endpointController = controller;
          const askedAt = this.clock.now();
          let deadline: unknown;
          type Settled = Omit<EndpointRecord, "by"> & { finished: boolean };
          const expired = new Promise<Settled>((resolve) => {
            deadline = this.clock.setTimer(
              () => resolve({ finished: false, semantic: "timeout" }),
              this.timing.endpointDeadlineMs,
            );
          });
          const asked = Promise.resolve()
            .then(() => this.ports.endpoint?.(text, controller.signal))
            .then(
              (value): Settled => {
                const result: EndpointResult =
                  typeof value === "string"
                    ? { decision: value }
                    : (value ?? { decision: "unavailable" });
                const reported =
                  Number.isFinite(result.latencyMs) &&
                  (result.latencyMs as number) >= 0
                    ? Math.round(result.latencyMs as number)
                    : Math.max(0, Math.round(this.clock.now() - askedAt));
                const latencyMs = Math.min(reported, 3_600_000);
                if (result.decision === "finished")
                  return { finished: true, semantic: "complete", latencyMs };
                if (result.decision === "continue")
                  return { finished: false, semantic: "incomplete", latencyMs };
                return {
                  finished: false,
                  semantic: "unavailable",
                  ...(typeof result.reason === "string"
                    ? { reason: result.reason }
                    : {}),
                };
              },
              (): Settled => ({ finished: false, semantic: "error" }),
            );
          // A slow, failing, unavailable or absent decision never blocks: the long gap still submits.
          void Promise.race([asked, expired]).then((settled) => {
            this.clock.clearTimer(deadline);
            controller.abort();
            // A superseded call (new speech, a re-scheduled gap or a submission) is dropped.
            if (this.endpointController !== controller) return;
            this.endpointController = undefined;
            if (!owns()) return;
            const { finished, ...outcome } = settled;
            this.endpointOutcome = outcome;
            if (finished) this.submit(session, "semantic");
          });
        },
        Math.max(0, this.timing.shortGapMs - elapsed),
      );
    this.longTimer = this.clock.setTimer(
      () => {
        this.longTimer = undefined;
        if (owns()) this.submit(session, "gap");
      },
      Math.max(0, this.timing.longGapMs - elapsed),
    );
  }

  // --- Turns --------------------------------------------------------------------------------

  private submit(session: number, by: EndpointRecord["by"]) {
    if (!this.current(session) || this.response) return;
    const text = this.utteranceText();
    this.clearTimers();
    // A call still in flight when the long gap submits counts as a timeout for this utterance.
    this.endpointController?.abort();
    this.endpointController = undefined;
    const endpoint: EndpointRecord = {
      by,
      ...(this.endpointOutcome ?? {
        semantic: this.ports.endpoint ? "timeout" : "not-asked",
      }),
    };
    this.endpointOutcome = undefined;
    this.segments = [];
    ++this.utteranceEpoch;
    if (!text) return;
    const turn = ++this.turn;
    const response: Response = {
      turnId: randomId(),
      controller: new AbortController(),
      sentences: [],
      played: 0,
      started: false,
    };
    this.response = response;
    this.publish({ phase: "thinking", transcript: text });
    this.ports.onTurn?.("submitted", response.turnId, { endpoint });
    const previous = this.inflight;
    const run = this.respond(session, turn, response, text, previous);
    this.inflight = run.catch(() => {});
  }

  private owned(session: number, turn: number, response: Response) {
    return (
      this.current(session) &&
      this.turn === turn &&
      this.response === response &&
      !response.controller.signal.aborted
    );
  }

  private async respond(
    session: number,
    turn: number,
    response: Response,
    text: string,
    previous: Promise<unknown>,
  ) {
    const guard = () => {
      if (!this.owned(session, turn, response)) throw stopped();
      this.ports.assertCurrent();
    };
    try {
      // One request at a time: an interrupted request settles before the next turn is sent.
      await previous;
      guard();
      let reply = await this.ports.send({
        turnId: response.turnId,
        text,
        voiceTurnSignal: this.ports.turnSignal?.(text),
        signal: response.controller.signal,
      });
      guard();
      if (
        !reply ||
        reply.requestId !== response.turnId ||
        reply.conversationId !== this.ports.conversationId ||
        !reply.userMessageId?.trim() ||
        !reply.assistantMessageId?.trim() ||
        reply.interrupted ||
        typeof reply.text !== "string"
      )
        throw new VoiceAssistantError(
          "reply",
          "The voice reply was not confirmed for this turn.",
        );
      if (reply.awaitingUserInput !== undefined) {
        const { proposalId, digest } =
          reply.awaitingUserInput ??
          ({} as { proposalId?: unknown; digest?: unknown });
        if (
          reply.complete !== false ||
          typeof proposalId !== "string" ||
          !proposalId.trim() ||
          typeof digest !== "string" ||
          !digest.trim()
        )
          throw new VoiceAssistantError(
            "reply",
            "The owner-input pause was not confirmed for this turn.",
          );
        const pausedReply = reply.assistantMessageId;
        const pause: AssistantAwaitingInput = {
          proposalId,
          digest,
          requestId: response.turnId,
          conversationId: this.ports.conversationId,
          userMessageId: reply.userMessageId,
          assistantMessageId: pausedReply,
        };
        // The microphone is off while the owner reviews; nothing heard meanwhile is sent.
        const capture = this.capture;
        this.capture = undefined;
        await Promise.resolve(capture?.cancel()).catch(() => {});
        this.segments = [];
        guard();
        reply = await new Promise<AssistantReply>((resolve, reject) => {
          this.awaiting = { pause, resolve, resolved: false };
          response.controller.signal.addEventListener(
            "abort",
            () => reject(stopped()),
            { once: true },
          );
          this.publish({
            phase: "awaiting-user-input",
            transcript: text,
            replyId: pausedReply,
            awaitingUserInput: { ...pause },
          });
        });
        this.awaiting = undefined;
        guard();
        if (!this.mutedValue) await this.open(session);
        guard();
      }
      // Proposals need explicit review in the conversation: voice never approves them.
      if (reply.complete !== true)
        throw new VoiceAssistantError(
          "reply",
          "The voice reply was not confirmed for this turn.",
        );
      response.replyId = reply.assistantMessageId;
      const spoken = this.ports.speakable
        ? this.ports.speakable(reply.text)
        : reply.text;
      response.sentences = splitSpokenSentences(spoken);
      if (!response.sentences.length) {
        this.finishResponse(response);
        return;
      }
      for (const sentence of response.sentences) {
        guard();
        const playback = this.ports.speak({
          turnId: response.turnId,
          replyId: reply.assistantMessageId,
          text: sentence,
          signal: response.controller.signal,
          onStarted: () => {
            if (!this.owned(session, turn, response) || response.started)
              return;
            response.started = true;
            this.ports.onTurn?.("first-audio", response.turnId);
            this.publish({
              phase: "speaking",
              replyId: reply.assistantMessageId,
            });
          },
        });
        this.speech.add(playback);
        void playback
          .catch(() => {})
          .finally(() => this.speech.delete(playback));
        await playback;
        guard();
        response.played++;
      }
      this.lastSpoken = {
        text: response.sentences.join(" "),
        at: this.clock.now(),
      };
      this.ports.onHeard?.({
        turnId: response.turnId,
        replyId: reply.assistantMessageId,
        heard: response.sentences.join(" "),
        unheard: "",
        interrupted: false,
      });
      this.finishResponse(response);
    } catch (error) {
      if (!this.owned(session, turn, response)) return; // Interrupted or stopped: already accounted.
      if ((error as { name?: unknown })?.name === "AbortError") return;
      if (response.replyId) this.reportInterrupted(response);
      this.response = undefined;
      await this.fail(session, error);
    }
  }

  private finishResponse(response: Response) {
    if (this.response !== response) return;
    this.response = undefined;
    for (const segment of this.segments)
      if (segment.tentative === response) delete segment.tentative;
    this.ports.onTurn?.("finished", response.turnId);
    this.publish(this.listeningState());
    // Speech that arrived while the reply played becomes the next turn.
    this.schedule();
  }

  /** Barge-in: abort the reply in flight and keep only what was played. */
  private interrupt() {
    const response = this.response;
    if (!response) return;
    ++this.turn;
    this.response = undefined;
    for (const segment of this.segments)
      if (segment.tentative === response) delete segment.tentative;
    response.controller.abort(
      new DOMException("Voice reply interrupted", "AbortError"),
    );
    if (response.started)
      this.lastSpoken = { text: audible(response), at: this.clock.now() };
    this.reportInterrupted(response);
    this.ports.onTurn?.("interrupted", response.turnId);
  }

  private reportInterrupted(response: Response) {
    if (!response.replyId) return;
    const heard = response.sentences.slice(0, response.played).join(" ");
    const unheard = response.sentences.slice(response.played).join(" ");
    this.ports.onHeard?.({
      turnId: response.turnId,
      replyId: response.replyId,
      heard,
      unheard,
      interrupted: true,
    });
  }

  private async drainSpeech() {
    await Promise.all(
      [...this.speech].map((pending) => pending.catch(() => {})),
    );
  }
}
