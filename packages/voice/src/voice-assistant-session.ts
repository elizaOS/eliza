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
 * `send`.
 *
 * Busy hold: submission closes the capture (`close()`, never `cancel()`) and input stays closed
 * while the agent is busy with that turn: the request (and any ack spoken inside `send`), an
 * owner-input pause and the reply until its playback settled. The turn is sent only once the close
 * fulfilled (then `inputHeld` is published); a close that fails ends the conversation, and a Mute
 * close that fails before a turn waits on it ends it at once, also with nothing to send. A
 * close that never settles leaves the turn unsent until Stop, so the host bounds `close()`. After
 * the reply the capture reopens (`reopen` on the listen handlers) unless Mute, Stop or a binding
 * change keeps it closed; a reopen that fails ends the conversation. A closed capture's `onEnd`
 * still ends a held turn at once, and under Mute an utterance still waiting to be sent. Manual
 * Mute is otherwise independent of the hold. Speech never interrupts a busy turn:
 * `interruptSpeech()` or Stop does.
 * The tentative and ignored segment paths below (`bargeInConfirmMs`, `fullDuplex`) only act on a
 * capture that is open while a reply is pending or playing, which the hold never leaves.
 *
 * Open microphone (`openMic` option, used only over a capture that reports `fullDuplex`): there
 * is no busy hold. The capture stays open through the request and the reply, so:
 *
 *  - Speculative turns. The host sets short gaps and a turn is sent at the first pause. Speech
 *    that resumes before any reply audio is audible (held for `bargeInConfirmMs`, or a segment
 *    whose transcript passes the gate) aborts that request and carries its text into the
 *    utterance in progress: the next submission sends the joined text and names the aborted turn
 *    in `supersedes`. Nothing from the aborted request is spoken.
 *  - Barge-in. Speech during playback interrupts once its transcript passes the gate, or earlier
 *    when it is held for `playbackBargeInMs` (0 leaves the transcript gate alone). The reply is
 *    aborted, what was heard is reported, and the speech already captured becomes the next turn.
 *
 * A capture without `fullDuplex` keeps the busy hold even when `openMic` is set.
 *
 * Heard content: interrupting aborts the reply (the request and playback are cancelled through the
 * port's AbortSignal). Replies are played one sentence at a time; only sentences whose playback
 * completed count as heard. The sentence playing when the user interrupted is reported as
 * unheard: playback reports completion per utterance, not a position, so a partial sentence is
 * never claimed as spoken. `onHeard` reports the heard/unheard split for the host to keep in
 * conversation state.
 *
 * Streamed replies: a transport may pass the reply text as it streams (`send`'s `onText`). A
 * sentence is spoken before the reply is confirmed only when its frame is confirmed model text (not
 * provisional) and the transport has proven the reply is a plain direct reply (`direct`: no
 * proposal or owner-input pause can follow). Anything else holds early speech: a provisional or
 * rewritten frame ends it for the turn. The confirmed reply then plays from the first sentence that
 * was not already spoken identically, so a confirmed sentence is never dropped.
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
  /**
   * Input is closed while the agent is busy with a submitted turn (processing, its ack, the reply
   * until playback settled). Set only after the capture's own close fulfilled.
   */
  inputHeld?: boolean;
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
  /** The end-of-turn stage that answered (`createEndpointChain`): the local scorer or Clef. */
  path?: "local" | "clef";
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
  /** The end-of-turn stage whose answer this records, when the port named one. */
  path?: "local" | "clef";
}
/** Wire metadata for one streamed text frame (`send`'s `onText`). */
export interface AssistantTextFrame {
  /** Where the text came from; only `"model"` text (or no origin) extends the final reply. */
  origin?: "model" | "model_draft" | "action_callback";
  /** The wire marks this text provisional (a draft or action status the final reply may replace). */
  provisional?: boolean;
  /**
   * The transport has established that this turn's reply is a plain direct reply: no action
   * proposal, owner-input pause or action outcome can follow. Without it streamed text is held
   * until the reply is confirmed.
   */
  direct?: boolean;
}
export interface AssistantHeard {
  /** The turn's id, which is also the reply's `requestId`. */
  turnId: string;
  /**
   * The confirmed assistant message, or '' when the user interrupted streamed speech before the
   * reply was confirmed: the host then finds the reply by `turnId` (its request id).
   */
  replyId: string;
  /** The contiguous prefix whose playback completed, in order. */
  heard: string;
  /** The remainder of the plan after the confirmed prefix. */
  unheard: string;
  interrupted: boolean;
  /**
   * Playback of the reply failed (for example the speech service refused it); the user did not
   * interrupt it. A reporter must not empty the stored reply for a failure.
   */
  playbackFailed?: boolean;
  /** The reply stream failed after early speech began; playback itself did not fail. */
  replyFailed?: boolean;
}
export interface AssistantCapture {
  /**
   * Finalize: segments closed by this call still deliver their final before it resolves. Rejects
   * when the input could not be confirmed closed, within a bound the host sets: a close that never
   * settles keeps a submitted turn unsent and Stop waiting.
   */
  close(): Promise<void>;
  /**
   * Discard: no further segment results are delivered. Rejects while the input could not be
   * confirmed off; calling it again asks again.
   */
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
  /** An automatic reopen after a busy hold: refused (never prompted) after a call, pause or permission loss. */
  reopen?: true;
}
export interface AssistantPorts {
  readonly conversationId: string;
  /** Throws when the owner, account, agent session, view or draft binding changed. */
  assertCurrent(): void;
  /** A rejection that carries `cancel` left a capture unconfirmed: `cancel` asks it again. */
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
      /** Segment speech start minus the last reply's playback end; omitted when either is unknown. */
      turnStartedAfterReplyEndMs?: number;
      echoCancelled: boolean;
    },
  ): boolean;
  /** Turn signal metadata for the agent (upstream buildVoiceTurnSignal). */
  turnSignal?(text: string): unknown;
  /**
   * `onText`, when the transport streams, receives the reply text accumulated so far with that
   * frame's wire metadata. Sentences it completes are spoken at once only from confirmed frames of
   * a reply proven direct (see AssistantTextFrame); the confirmed reply then supplies the rest.
   */
  send(input: {
    turnId: string;
    text: string;
    voiceTurnSignal: unknown;
    signal: AbortSignal;
    onText?: (text: string, frame?: AssistantTextFrame) => void;
    /** The turn this one replaces: sent at a pause, then aborted unheard when speech resumed. */
    supersedes?: string;
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
    event: "submitted" | "first-audio" | "finished" | "interrupted" | "resumed",
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
  /**
   * Open microphone only: speech held this long while the reply plays interrupts it before its
   * transcript. 0 (the default) leaves playback interruption to the transcript gate.
   */
  playbackBargeInMs: number;
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
  playbackBargeInMs: 0,
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
/** A controller that also aborts (with the same reason) when `parent` aborts. */
const linkedController = (parent: AbortSignal) => {
  const controller = new AbortController();
  if (parent.aborted) controller.abort(parent.reason);
  else
    parent.addEventListener("abort", () => controller.abort(parent.reason), {
      once: true,
    });
  return controller;
};
const unconfirmedClose = () =>
  new VoiceAssistantError(
    "capture",
    "The microphone did not confirm it was off.",
  );

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
  /** When the segment's speech started, on the session clock. */
  startedAt?: number;
  /** Started while a reply was pending or playing: interrupts only once confirmed. */
  tentative?: Response;
  /** Started during playback over a capture without echo cancellation: never a turn. */
  ignored?: boolean;
};
type Response = {
  turnId: string;
  /** The utterance this turn was sent with. */
  text: string;
  /** The taken-back turn this one replaces. */
  supersedes?: string;
  /** `send` was called for this turn. */
  sent?: boolean;
  controller: AbortController;
  replyId?: string;
  sentences: string[];
  played: number;
  started: boolean;
};
/** Busy hold: from submission until the turn's reply has played. `closes`: the closes it waits on. */
type Hold = { response?: Response; closed: boolean; closes: Promise<void>[] };
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
  private hold?: Hold;
  private readonly openMic: boolean;
  private readonly pipelineSpeech: boolean;
  /** The aborted speculative turn whose text the utterance in progress carries. */
  private superseded?: string;

  private readonly ports: AssistantPorts;
  constructor(
    ports: AssistantPorts,
    options: {
      timing?: Partial<AssistantTiming>;
      clock?: AssistantClock;
      /** Keep the capture open through the reply (speculative turns and barge-in); needs `fullDuplex`. */
      openMic?: boolean;
      /**
       * Hand the next sentence to `speak` as soon as the current one is audible, so the host can
       * synthesize it during playback. The host must then play sentences in the order given and
       * settle each call when that sentence's playback ended.
       */
      pipelineSpeech?: boolean;
    } = {},
  ) {
    this.ports = ports;
    this.openMic = options.openMic === true;
    this.pipelineSpeech = options.pipelineSpeech === true;
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
    const { muted: _muted, inputHeld: _held, ...rest } = state;
    this.state = {
      ...rest,
      ...(this.mutedValue ? { muted: true } : {}),
      ...(this.hold?.closed ? { inputHeld: true } : {}),
    };
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
      void this.stop().catch(() => {});
    }
  }

  /**
   * Resolving proves every capture this conversation opened confirmed it is off. Rejects while one
   * has not; calling it again asks that capture again.
   */
  async stop(): Promise<void> {
    if (this.active) {
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
      this.superseded = undefined;
      const capture = this.capture,
        opening = this.opening;
      this.capture = undefined;
      this.opening = undefined;
      this.hold = undefined;
      this.publish({ phase: "idle" });
      // Discard: an utterance that was not submitted is not sent after Stop, including a muted
      // capture that is still finalizing. A capture still opening is discarded by open().
      if (capture) this.unreleased.add(capture);
      for (const closing of this.closingCaptures.keys())
        this.unreleased.add(closing);
      this.closingCaptures.clear();
      this.closing = Promise.all([this.closing, opening?.catch(() => {})]).then(
        () => {},
      );
    }
    await Promise.all([
      ...[...this.unreleased].map((capture) => this.discard(capture)),
      this.closing,
      this.drainSpeech(),
    ]);
    if (this.unreleased.size) throw unconfirmedClose();
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

  /** Captures still closing, each with its own close (rejects when that close failed). */
  private closingCaptures = new Map<AssistantCapture, Promise<void>>();
  /** Captures not yet confirmed off: stop() asks each again, and no capture opens over one. */
  private unreleased = new Set<Pick<AssistantCapture, "cancel">>();
  /** A refusal keeps the capture in `unreleased`, for the next stop() to ask again. */
  private async discard(capture: Pick<AssistantCapture, "cancel">) {
    this.unreleased.add(capture);
    try {
      await capture.cancel();
      this.unreleased.delete(capture);
    } catch {
      // stop() reports it: it rejects while this capture has not confirmed.
    }
  }
  private closeCapture(capture: AssistantCapture) {
    const session = this.session;
    const own = Promise.resolve().then(() => capture.close());
    this.closingCaptures.set(capture, own);
    const closed = own
      .catch(() => {
        // Not yet in Stop's hands: the capture stays to be discarded, since it may still be on.
        if (this.closingCaptures.has(capture)) this.unreleased.add(capture);
        // A submitted turn's barrier ends a close it waits on. Any other (Mute, with or without an
        // utterance waiting) ends the conversation now and retires that capture: the microphone may
        // still be on, so Mute is not left showing over it and Unmute never reopens.
        if (!this.hold?.closes.includes(own))
          void this.fail(session, unconfirmedClose());
      })
      .finally(() => this.closingCaptures.delete(capture));
    this.closing = Promise.all([this.closing, closed]).then(() => {});
    return own;
  }

  private async open(session: number, reopen = false) {
    if (this.capture || this.opening) return;
    // A muted capture's last segment is delivered before a new capture can open.
    await this.closing;
    this.check(session);
    if (this.unreleased.size) throw unconfirmedClose();
    // Never open while a submitted turn holds input closed (its release reopens) or during an
    // owner-review pause.
    if (
      this.capture ||
      this.opening ||
      this.mutedValue ||
      this.hold?.response ||
      (this.awaiting && !this.awaiting.resolved)
    )
      return;
    const signal = this.controller?.signal;
    if (!signal) throw stopped();
    const pending = this.ports
      .listen({
        signal,
        ...(reopen ? { reopen: true } : {}),
        onSpeechStart: (at) => {
          if (this.current(session) && !this.mutedValue && !this.hold?.response)
            this.speechStarted(at);
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
          if (this.current(session) && !this.mutedValue && !this.hold?.response)
            this.ports.onLevel?.(peak);
        },
      })
      .then(
        (capture) => {
          if (this.opening !== pending || !this.current(session))
            return this.discard(capture).then(() => undefined);
          this.opening = undefined;
          // Muted or held while the microphone was opening: it never stays on.
          if (this.mutedValue || this.hold?.response) {
            const closed = this.closeCapture(capture);
            if (this.hold?.response) this.hold.closes.push(closed);
            return undefined;
          }
          this.capture = capture;
          return capture;
        },
        (error) => {
          if (this.opening === pending) this.opening = undefined;
          if (typeof error?.cancel === "function") this.unreleased.add(error);
          throw error;
        },
      );
    this.opening = pending;
    await pending;
  }

  private async captureEnded(session: number, error?: unknown) {
    // An end while a turn is held fails at once, muted or not: its reply may need that transport.
    // So does one under Mute while an utterance still waits to be sent; Mute alone stays quiet.
    if (this.mutedValue && !this.hold?.response && !this.segments.length) {
      this.capture = undefined;
      return;
    }
    // The capture stays for Stop: a lost capture is not yet one that confirmed it is off.
    await this.fail(
      session,
      error ?? new VoiceAssistantError("capture", "The microphone stopped."),
    );
  }

  private async fail(session: number, error: unknown) {
    if (!this.current(session)) return;
    // A refused release stays held: the owner's own stop() asks it again and rejects.
    await this.stop().catch(() => {});
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

  private speechStarted(at: number) {
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
        void this.stop().catch(() => {});
        return;
      }
    }
    const segment: Segment = {
      closed: false,
      done: false,
      text: "",
      ...(Number.isFinite(at)
        ? { startedAt: Math.min(at, this.clock.now()) }
        : {}),
      ...(response ? { tentative: response } : {}),
    };
    this.segments.push(segment);
    if (response) {
      const session = this.session;
      // Held speech interrupts a pending request before its transcript; a blip closes first and waits
      // for the gate. While the reply plays the transcript gate confirms (residual echo of a sentence
      // can hold the VAD open), unless the host set a hold for an echo-cancelled open microphone.
      // Speech that began before the first audio and is still held once the reply plays starts the
      // playback hold then, so it interrupts like speech that began during playback.
      const arm = () => {
        const playing = response.started;
        const hold = playing
          ? this.timing.playbackBargeInMs
          : this.timing.bargeInConfirmMs;
        if (playing && hold <= 0) return;
        this.clock.setTimer(() => {
          if (
            !this.current(session) ||
            segment.closed ||
            segment.tentative !== response
          )
            return;
          if (response.started === playing) this.confirmBargeIn(segment);
          else arm();
        }, hold);
      };
      arm();
      return;
    }
    this.publish(this.listeningState());
  }

  private confirmBargeIn(segment: Segment) {
    const response = segment.tentative;
    delete segment.tentative;
    if (response && this.response === response) {
      // A speculative turn nobody heard: its text rejoins the utterance the user is still speaking.
      const resumed = this.openMic && !response.started;
      this.interrupt();
      if (resumed) {
        this.segments.unshift({
          closed: true,
          done: true,
          text: response.text,
        });
        // Only a turn the host received can be replaced: one taken back while it still waited for
        // the request before it passes on the turn that one replaced.
        this.superseded = response.sent ? response.turnId : response.supersedes;
        this.ports.onTurn?.("resumed", response.turnId);
      }
    }
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
      const startedAfterReply =
        !playing &&
        segment.startedAt !== undefined &&
        Number.isFinite(this.lastSpoken.at)
          ? segment.startedAt - this.lastSpoken.at
          : undefined;
      const context = {
        recentAgentReply: playing ? audible(playing) : this.lastSpoken.text,
        replyAgeMs: playing
          ? 0
          : Math.max(0, this.clock.now() - this.lastSpoken.at),
        agentSpeaking: !!playing,
        ...(startedAfterReply !== undefined
          ? { turnStartedAfterReplyEndMs: startedAfterReply }
          : {}),
        echoCancelled: this.capture?.fullDuplex === true,
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
                const path =
                  result.path === "local" || result.path === "clef"
                    ? { path: result.path }
                    : {};
                if (result.decision === "finished")
                  return {
                    finished: true,
                    semantic: "complete",
                    latencyMs,
                    ...path,
                  };
                if (result.decision === "continue")
                  return {
                    finished: false,
                    semantic: "incomplete",
                    latencyMs,
                    ...path,
                  };
                return {
                  finished: false,
                  semantic: "unavailable",
                  ...(typeof result.reason === "string"
                    ? { reason: result.reason }
                    : {}),
                  ...path,
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
    const supersedes = this.superseded;
    this.superseded = undefined;
    if (!text) return;
    const turn = ++this.turn;
    const response: Response = {
      turnId: randomId(),
      text,
      ...(supersedes ? { supersedes } : {}),
      controller: new AbortController(),
      sentences: [],
      played: 0,
      started: false,
    };
    this.response = response;
    if (this.openMic && this.capture?.fullDuplex === true) {
      // Open microphone: no hold. The capture keeps listening for resumed speech and barge-in.
      this.publish({ phase: "thinking", transcript: text });
      this.ports.onTurn?.("submitted", response.turnId, { endpoint });
      const run = this.respond(
        session,
        turn,
        response,
        text,
        this.inflight,
        Promise.resolve(),
        supersedes,
      );
      this.inflight = run.catch(() => {});
      return;
    }
    const closed = this.holdInput(response);
    closed.catch(() => {});
    this.publish({ phase: "thinking", transcript: text });
    this.ports.onTurn?.("submitted", response.turnId, { endpoint });
    const previous = this.inflight;
    const run = this.respond(
      session,
      turn,
      response,
      text,
      previous,
      closed,
      supersedes,
    );
    this.inflight = run.catch(() => {});
  }

  /** Holds input closed through a response or an owner-input pause. */
  private holdInput(response: Response): Promise<void> {
    // Busy hold: input closes now, finalizing (never cancelling) the capture, with any Mute close
    // still in flight; a capture still opening is closed by open() as it arrives.
    const capture = this.capture,
      opening = this.opening;
    const hold: Hold = {
      response,
      closed: false,
      closes: [...this.closingCaptures.values()],
    };
    this.hold = hold;
    this.capture = undefined;
    if (capture) hold.closes.push(this.closeCapture(capture));
    // Only confirmed closure publishes inputHeld; a failed close ends the conversation.
    const closed = (async () => {
      await opening?.catch(() => {});
      await Promise.all(hold.closes).catch(() => {
        throw unconfirmedClose();
      });
      if (this.hold === hold) {
        hold.closed = true;
        this.republish();
      }
    })();
    return closed;
  }

  /** Extends the heard prefix only when the next sentence completes. */
  private async playSentence(
    session: number,
    turn: number,
    response: Response,
    index: number,
    signal: AbortSignal,
    guard: () => void,
    audible?: () => void,
  ) {
    guard();
    const playback = this.ports.speak({
      turnId: response.turnId,
      replyId: response.replyId ?? "",
      text: response.sentences[index] as string,
      signal,
      onStarted: () => {
        audible?.();
        if (!this.owned(session, turn, response) || response.started) return;
        response.started = true;
        this.ports.onTurn?.("first-audio", response.turnId);
        this.publish({ phase: "speaking", replyId: response.replyId ?? "" });
      },
    });
    this.speech.add(playback);
    void playback.catch(() => {}).finally(() => this.speech.delete(playback));
    await playback;
    guard();
    if (index === response.played) response.played++;
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
    closed: Promise<void>,
    supersedes?: string,
  ) {
    const guard = () => {
      if (!this.owned(session, turn, response)) throw stopped();
      try {
        this.ports.assertCurrent();
      } catch (error) {
        // A changed binding stops quietly, as recheck() does; it is not a failed turn.
        void this.stop();
        throw error;
      }
    };
    let playbackFailed = false;
    try {
      // One request at a time: an interrupted request settles before the next turn is sent.
      await previous;
      guard();
      // Input closes before the request: `send` (with any ack it speaks) and the reply never run
      // over an open microphone. A close that failed ends the conversation, and nothing reopens.
      await new Promise<void>((resolve, reject) => {
        response.controller.signal.addEventListener(
          "abort",
          () => reject(stopped()),
          { once: true },
        );
        closed.then(resolve, () => reject(unconfirmedClose()));
      });
      guard();
      const speakable = (value: string) =>
        this.ports.speakable ? this.ports.speakable(value) : value;
      // The plan supplies the heard/unheard accounting. `begun` is the prefix already handed to
      // the speaker, including any queued sentence. Only the rest may be withdrawn here.
      const plan: string[] = [];
      response.sentences = plan;
      let begun = 0;
      let failure: { error: unknown } | undefined;
      let pumping: Promise<void> = Promise.resolve();
      let running = false;
      // Playback of this reply's sentences; aborted with the response, or alone when a pause
      // withdraws streamed speech.
      let voice = linkedController(response.controller.signal);
      // Wakes a pump that is only waiting for playback: more sentences were planned meanwhile.
      let more: (() => void) | undefined;
      const pump = () => {
        if (running) {
          more?.();
          return;
        }
        if (failure) return;
        running = true;
        const signal = voice.signal;
        pumping = (async () => {
          try {
            // Pipelined: the sentence after the audible one is already with the speaker. Its
            // playback cannot start before the previous one ended, so two are in flight at most.
            const pending: Promise<void>[] = [];
            let pipelineFailure: { error: unknown } | undefined;
            let wakeFailure!: () => void;
            const failureWake = this.pipelineSpeech
              ? new Promise<void>((resolve) => {
                  wakeFailure = resolve;
                })
              : undefined;
            for (;;) {
              while (!pipelineFailure && begun < plan.length) {
                const index = begun++;
                let audible!: () => void;
                const started = new Promise<void>((resolve) => {
                  audible = resolve;
                });
                const playback = this.playSentence(
                  session,
                  turn,
                  response,
                  index,
                  signal,
                  guard,
                  audible,
                );
                if (!failureWake) {
                  await playback;
                  continue;
                }
                pending.push(playback);
                void playback.catch((error: unknown) => {
                  // An earlier sentence can fail while its successor waits to start. Intentional
                  // cancellation still lets the current playback settle through its normal port.
                  if (signal.aborted) return;
                  pipelineFailure ??= { error };
                  wakeFailure();
                });
                await Promise.race([started, playback, failureWake]);
              }
              if (pipelineFailure) throw pipelineFailure.error;
              if (!pending.length) {
                // One sentence at a time: nothing is in flight once the loop above is done.
                await Promise.all(pending);
                if (begun >= plan.length) break;
                continue;
              }
              // Sentences planned while the handed-over ones play (a later stream frame, or the
              // confirmed reply) are handed over at once, not dropped with the settled pump.
              const planned = new Promise<"more">((resolve) => {
                more = () => resolve("more");
              });
              const settled = await Promise.race([
                Promise.all(pending).then(() => "played" as const),
                planned,
              ]);
              more = undefined;
              if (settled === "played" && begun >= plan.length) break;
            }
          } catch (error) {
            playbackFailed = true;
            failure ??= { error };
          } finally {
            running = false;
          }
        })();
      };
      // Early speech: while the stream is confirmed text of a reply proven direct, each sentence it
      // completes is spoken at once, one at a time, so the first plays while the rest is generated.
      let early = true;
      const endEarly = () => {
        early = false;
        plan.length = begun; // The confirmed reply supplies the unhanded suffix.
      };
      const onText = (partial: string, frame?: AssistantTextFrame) => {
        if (
          !early ||
          !this.owned(session, turn, response) ||
          typeof partial !== "string"
        )
          return;
        // Provisional text (a Stage-1 draft or an action status) is never spoken, and after it the
        // stream is no longer trusted for this turn: the confirmed reply decides.
        if (
          frame?.provisional === true ||
          (frame?.origin !== undefined && frame.origin !== "model")
        ) {
          endEarly();
          return;
        }
        // Not yet proven a plain direct reply (it may still pause or carry a proposal): hold.
        if (frame?.direct !== true) return;
        const parts = splitSpokenSentences(speakable(partial));
        // The last piece may still be growing; only the ones before it are complete.
        const complete = parts.length - 1;
        // A rewrite of what was already planned ends early speech.
        if (
          plan.length > Math.max(complete, 0) ||
          !plan.every((part, index) => part === parts[index])
        ) {
          endEarly();
          return;
        }
        if (plan.length >= complete) return;
        plan.push(...parts.slice(plan.length, complete));
        pump();
      };
      response.sent = true;
      let reply = await this.ports.send({
        turnId: response.turnId,
        text,
        voiceTurnSignal: this.ports.turnSignal?.(text),
        signal: response.controller.signal,
        onText,
        ...(supersedes ? { supersedes } : {}),
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
        // A paused reply is never spoken: stop streamed speech now. The resumed reply is another
        // message, so it is spoken in full and accounted on its own.
        endEarly();
        if (begun) {
          const prior = failure;
          voice.abort(stopped());
          await pumping;
          if (prior) throw prior.error;
          guard();
          voice = linkedController(response.controller.signal);
          failure = undefined;
          playbackFailed = false;
          plan.length = begun = response.played = 0;
          response.started = false;
        }
        // Open-microphone replies enter the same hold before owner review. Final segments from
        // its closing capture wait for the resumed reply instead of superseding the paused turn.
        if (!this.hold) {
          for (const segment of this.segments)
            if (segment.tentative === response) delete segment.tentative;
          await this.holdInput(response);
          guard();
        }
        // The busy hold keeps input closed while the owner reviews and until the resumed reply played.
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
      }
      // Proposals need explicit review in the conversation: voice never approves them.
      if (reply.complete !== true)
        throw new VoiceAssistantError(
          "reply",
          "The voice reply was not confirmed for this turn.",
        );
      response.replyId = reply.assistantMessageId;
      endEarly();
      const final = splitSpokenSentences(speakable(reply.text));
      // Streamed sentences already handed to the speaker are skipped only while they match the confirmed
      // reply sentence for sentence; from the first one that does not, the confirmed reply plays.
      let same = 0;
      while (same < begun && plan[same] === final[same]) same++;
      plan.push(...final.slice(same));
      pump();
      await pumping;
      if (failure) throw failure.error;
      guard();
      if (!response.sentences.length) {
        this.finishResponse(response);
        return;
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
      // A reply that failed after streamed speech started still reports what
      // was heard; before confirmation the host finds it by turnId.
      if (response.replyId || response.started)
        this.reportInterrupted(response, playbackFailed ? "playback" : "reply");
      this.response = undefined;
      // Streamed speech may still be playing: the failed turn stops it now.
      response.controller.abort(stopped());
      await this.fail(session, error);
    }
  }

  private finishResponse(response: Response) {
    if (this.response !== response) return;
    this.response = undefined;
    if (this.hold?.response === response) this.release(this.hold);
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
    if (this.hold?.response === response) this.release(this.hold);
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

  /**
   * The held turn is over: once its run (the request and an ack inside `send`) and every playback
   * settled, reopen unless Mute, Stop or a binding change keeps input closed. Until then the hold
   * keeps refusing an Unmute's open, also after an interruption whose playback is still stopping.
   */
  private release(hold: Hold) {
    const session = this.session;
    void Promise.all([this.inflight, this.drainSpeech()])
      .then(() => {
        hold.response = undefined;
        return this.open(session, true);
      })
      .then(
        () => {
          if (this.hold === hold) this.hold = undefined;
          if (this.current(session)) this.republish();
        },
        (error) => {
          if (this.hold === hold) this.hold = undefined;
          if (this.current(session)) void this.fail(session, error);
        },
      );
  }

  private reportInterrupted(
    response: Response,
    failure?: "playback" | "reply",
  ) {
    // Before confirmation only streamed speech can have played: it is reported once it started.
    if (!response.replyId && !response.started) return;
    const heard = response.sentences.slice(0, response.played).join(" ");
    const unheard = response.sentences.slice(response.played).join(" ");
    this.ports.onHeard?.({
      turnId: response.turnId,
      replyId: response.replyId ?? "",
      heard,
      unheard,
      interrupted: true,
      ...(failure === "playback" ? { playbackFailed: true } : {}),
      ...(failure === "reply" ? { replyFailed: true } : {}),
    });
  }

  private async drainSpeech() {
    await Promise.all(
      [...this.speech].map((pending) => pending.catch(() => {})),
    );
  }
}
