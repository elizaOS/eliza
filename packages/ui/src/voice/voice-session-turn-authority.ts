/**
 * Browser adapter for the provider-neutral TurnCoordinator.
 *
 * The WebSocket protocol intentionally carries provider trace ids rather than
 * coordinator ids. This adapter binds a trace only after a response is
 * committed and issues short-lived leases for every browser side effect. The
 * shared reducer remains the authority for session/turn/response identity;
 * this file only translates the existing protocol into that contract.
 */

import {
  createTurnCoordinatorState,
  isCurrentResponse,
  type ResponseId,
  reduceTurnCoordinator,
  type SpeechAttemptId,
  type TurnCoordinatorEffect,
  type TurnCoordinatorEvent,
  type TurnCoordinatorRejection,
  type TurnCoordinatorState,
  type TurnDisposition,
  type TurnId,
} from "@elizaos/shared";

export interface VoiceSessionAuthorityTicket {
  readonly epoch: number;
  readonly revision: number;
  readonly sessionId: string;
}

export interface VoiceSessionLease {
  readonly epoch: number;
  readonly sessionId: string;
}

export interface VoiceResponseLease extends VoiceSessionAuthorityTicket {
  readonly responseId: ResponseId;
}

export interface VoiceAuthorityTransition {
  readonly accepted: boolean;
  readonly effects: readonly TurnCoordinatorEffect[];
  readonly ticket: VoiceSessionAuthorityTicket | null;
  readonly rejection?: TurnCoordinatorRejection | "stale_playback";
}

interface PlaybackOwner {
  readonly epoch: number;
  readonly responseId: ResponseId;
  readonly sequence: number;
}

type EventFactory = (state: TurnCoordinatorState) => TurnCoordinatorEvent;

function hasSpokenText(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

export class VoiceSessionTurnAuthority {
  private coordinator: TurnCoordinatorState | null = null;
  private authorityEpoch = 0;
  private authorityRevision = 0;
  private activeWireTraceId: string | null = null;
  private activeWireResponseId: ResponseId | null = null;
  private audioIngressResponseId: ResponseId | null = null;
  private playbackOwner: PlaybackOwner | null = null;

  get state(): TurnCoordinatorState | null {
    return this.coordinator;
  }

  get epoch(): number {
    return this.authorityEpoch;
  }

  get revision(): number {
    return this.authorityRevision;
  }

  get speechAttemptId(): SpeechAttemptId | null {
    return this.coordinator?.speechAttempt?.id ?? null;
  }

  get playbackResponseId(): ResponseId | null {
    return this.playbackOwner?.responseId ?? null;
  }

  openSession(
    sessionId: string,
    atMs: number,
    policy?: { speechConfirmationTimeoutMs?: number },
  ): VoiceSessionLease {
    this.authorityEpoch += 1;
    this.authorityRevision += 1;
    this.coordinator = createTurnCoordinatorState({ sessionId, atMs, policy });
    this.activeWireTraceId = null;
    this.activeWireResponseId = null;
    this.audioIngressResponseId = null;
    this.playbackOwner = null;
    return { epoch: this.authorityEpoch, sessionId };
  }

  currentSessionLease(): VoiceSessionLease | null {
    const state = this.coordinator;
    return state
      ? { epoch: this.authorityEpoch, sessionId: state.sessionId }
      : null;
  }

  isSessionLeaseCurrent(lease: VoiceSessionLease | null): boolean {
    return Boolean(
      lease &&
        this.coordinator &&
        this.coordinator.lifecycle !== "closed" &&
        lease.epoch === this.authorityEpoch &&
        lease.sessionId === this.coordinator.sessionId,
    );
  }

  isReadySession(sessionId: string): boolean {
    return Boolean(
      this.coordinator &&
        this.coordinator.lifecycle === "listening" &&
        this.coordinator.sessionId === sessionId,
    );
  }

  isTransitionCurrent(
    transition: VoiceAuthorityTransition | VoiceSessionAuthorityTicket,
  ): boolean {
    const ticket = "ticket" in transition ? transition.ticket : transition;
    return Boolean(
      ticket &&
        this.coordinator &&
        ticket.epoch === this.authorityEpoch &&
        ticket.revision === this.authorityRevision &&
        ticket.sessionId === this.coordinator.sessionId,
    );
  }

  beginProvisionalSpeech(atMs: number): VoiceAuthorityTransition {
    return this.publish([
      (state) => ({
        type: "speech/provisional_started",
        sessionId: state.sessionId,
        atMs,
      }),
    ]);
  }

  rejectProvisionalSpeech(
    speechAttemptId: SpeechAttemptId,
    atMs: number,
    source: "detector" | "timer",
  ): VoiceAuthorityTransition {
    return this.publish([
      (state) =>
        source === "timer"
          ? {
              type: "timer/speech_confirmation_elapsed",
              sessionId: state.sessionId,
              atMs,
              speechAttemptId,
            }
          : {
              type: "speech/provisional_rejected",
              sessionId: state.sessionId,
              atMs,
              speechAttemptId,
            },
    ]);
  }

  acceptPartialTranscript(
    text: string,
    atMs: number,
  ): VoiceAuthorityTransition {
    if (!hasSpokenText(text)) return this.noop(false, "invalid_state");
    return this.publish(this.transcriptSteps(atMs, false));
  }

  acceptTentativeEot(atMs: number): VoiceAuthorityTransition {
    const state = this.coordinator;
    const turn = state?.turn;
    if (!state || !turn) return this.noop(false, "stale_turn");
    return this.publish([
      (current) => ({
        type: "eot/tentative",
        sessionId: current.sessionId,
        atMs,
        turnId: current.turn?.id as TurnId,
        transcriptRevision: current.turn?.transcriptRevision ?? 0,
      }),
    ]);
  }

  commitTranscript(
    text: string,
    traceId: string,
    atMs: number,
    disposition: TurnDisposition = hasSpokenText(text)
      ? "respond"
      : "no_response",
  ): VoiceAuthorityTransition {
    if (disposition === "no_response" && this.coordinator?.speechAttempt) {
      const transition = this.rejectProvisionalSpeech(
        this.coordinator.speechAttempt.id,
        atMs,
        "detector",
      );
      if (transition.accepted) {
        this.activeWireTraceId = traceId;
        this.activeWireResponseId = null;
        this.audioIngressResponseId = null;
      }
      return transition;
    }
    const steps = this.transcriptSteps(atMs, true);
    steps.push((state) => ({
      type: "turn/commit",
      sessionId: state.sessionId,
      atMs,
      turnId: state.turn?.id as TurnId,
      transcriptRevision: state.turn?.transcriptRevision ?? 0,
      disposition,
    }));
    const transition = this.publish(steps);
    if (!transition.accepted) return transition;
    this.bindWireResponse(traceId);
    return transition;
  }

  /** Own a server-originated response such as the optional opening greeting. */
  bootstrapResponse(traceId: string, atMs: number): VoiceAuthorityTransition {
    if (this.coordinator?.response) {
      return this.activeWireTraceId === traceId
        ? this.noop(true)
        : this.noop(false, "response_active");
    }
    const transition = this.publish([
      (state) => ({
        type: "speech/confirmed",
        sessionId: state.sessionId,
        atMs,
        continuation: "new_turn",
      }),
      (state) => ({
        type: "transcript/revised",
        sessionId: state.sessionId,
        atMs,
        turnId: state.turn?.id as TurnId,
        transcriptRevision: (state.turn?.transcriptRevision ?? 0) + 1,
      }),
      (state) => ({
        type: "turn/commit",
        sessionId: state.sessionId,
        atMs,
        turnId: state.turn?.id as TurnId,
        transcriptRevision: state.turn?.transcriptRevision ?? 0,
        disposition: "respond",
      }),
    ]);
    if (transition.accepted) this.bindWireResponse(traceId);
    return transition;
  }

  acceptModelStarted(traceId: string, atMs: number): VoiceAuthorityTransition {
    const responseId = this.currentWireResponse(traceId);
    if (!responseId) return this.noop(false, "stale_response");
    return this.publish([
      (state) => ({
        type: "response/model_started",
        sessionId: state.sessionId,
        atMs,
        responseId,
      }),
    ]);
  }

  acceptSpeakingStarted(
    traceId: string,
    atMs: number,
  ): VoiceAuthorityTransition {
    let responseId = this.currentWireResponse(traceId);
    let bootstrap: VoiceAuthorityTransition | null = null;
    if (!responseId && !this.coordinator?.response) {
      bootstrap = this.bootstrapResponse(traceId, atMs);
      if (!bootstrap.accepted) return bootstrap;
      responseId = this.currentWireResponse(traceId);
    }
    if (!responseId) return this.noop(false, "stale_response");
    const speaking = this.publish([
      (state) => ({
        type: "response/speaking_started",
        sessionId: state.sessionId,
        atMs,
        responseId: responseId as ResponseId,
      }),
    ]);
    if (speaking.accepted) this.audioIngressResponseId = responseId;
    if (!bootstrap?.effects.length) return speaking;
    return {
      ...speaking,
      effects: [...bootstrap.effects, ...speaking.effects],
    };
  }

  authorizeAudioFrame(): VoiceResponseLease | null {
    const state = this.coordinator;
    const responseId = this.audioIngressResponseId;
    if (!state || !responseId || !isCurrentResponse(state, responseId)) {
      return null;
    }
    return {
      epoch: this.authorityEpoch,
      revision: this.authorityRevision,
      sessionId: state.sessionId,
      responseId,
    };
  }

  isResponseLeaseCurrent(lease: VoiceResponseLease | null): boolean {
    return Boolean(
      lease &&
        this.isTransitionCurrent(lease) &&
        this.audioIngressResponseId === lease.responseId &&
        this.coordinator &&
        isCurrentResponse(this.coordinator, lease.responseId),
    );
  }

  acceptPlaybackEnqueued(
    lease: VoiceResponseLease,
    sequence: number,
    atMs: number,
  ): VoiceAuthorityTransition {
    if (!this.isResponseLeaseCurrent(lease)) {
      return this.noop(false, "stale_response");
    }
    const transition = this.publish([
      (state) => ({
        type: "playback/enqueued",
        sessionId: state.sessionId,
        atMs,
        responseId: lease.responseId,
      }),
    ]);
    if (transition.accepted) {
      this.playbackOwner = {
        epoch: this.authorityEpoch,
        responseId: lease.responseId,
        sequence,
      };
    }
    return transition;
  }

  acceptPlaybackDrained(
    sequence: number,
    atMs: number,
  ): VoiceAuthorityTransition {
    const owner = this.playbackOwner;
    if (
      !owner ||
      owner.epoch !== this.authorityEpoch ||
      owner.sequence !== sequence
    ) {
      return this.noop(false, "stale_playback");
    }
    const transition = this.publish([
      (state) => ({
        type: "playback/drained",
        sessionId: state.sessionId,
        atMs,
        responseId: owner.responseId,
      }),
    ]);
    if (transition.accepted) this.playbackOwner = null;
    return transition;
  }

  acceptSpeakingEnded(traceId: string, atMs: number): VoiceAuthorityTransition {
    const responseId = this.currentWireResponse(traceId);
    this.audioIngressResponseId = null;
    if (!responseId) {
      return this.isCurrentWireTrace(traceId)
        ? this.noop(true)
        : this.noop(false, "stale_response");
    }
    return this.publish([
      (state) => ({
        type: "response/settled",
        sessionId: state.sessionId,
        atMs,
        responseId,
        outcome: "spoken",
      }),
    ]);
  }

  acceptTurnEnded(
    traceId: string,
    outcome: "spoken" | "displayed" | "no_response" | "error" | "stopped",
    atMs: number,
  ): VoiceAuthorityTransition {
    if (!this.isCurrentWireTrace(traceId)) {
      return this.noop(false, "stale_response");
    }
    let transition: VoiceAuthorityTransition;
    const responseId = this.currentWireResponse(traceId);
    if (outcome === "stopped") {
      transition = this.publish([
        (state) => ({
          type: "interrupt/explicit",
          sessionId: state.sessionId,
          atMs,
          reason: "user_stop",
        }),
      ]);
    } else if (responseId) {
      transition = this.publish([
        (state) => ({
          type: "response/settled",
          sessionId: state.sessionId,
          atMs,
          responseId,
          outcome:
            outcome === "spoken"
              ? "spoken"
              : outcome === "error"
                ? "error"
                : "no_response",
        }),
      ]);
    } else {
      transition = this.noop(true);
    }
    if (transition.accepted) {
      this.activeWireTraceId = null;
      this.activeWireResponseId = null;
      this.audioIngressResponseId = null;
    }
    return transition;
  }

  acceptInterrupted(
    traceId: string,
    reason: "acoustic" | "explicit",
    atMs: number,
  ): VoiceAuthorityTransition {
    if (!this.isCurrentWireTrace(traceId)) {
      return this.noop(false, "stale_response");
    }
    const attemptId = this.coordinator?.speechAttempt?.id;
    const transition = this.publish([
      (state) =>
        reason === "acoustic"
          ? {
              type: "speech/confirmed",
              sessionId: state.sessionId,
              atMs,
              ...(attemptId ? { speechAttemptId: attemptId } : {}),
              continuation: "auto",
            }
          : {
              type: "interrupt/explicit",
              sessionId: state.sessionId,
              atMs,
              reason: "user_stop",
            },
    ]);
    if (transition.accepted) {
      this.activeWireTraceId = null;
      this.activeWireResponseId = null;
      this.audioIngressResponseId = null;
    }
    return transition;
  }

  explicitInterrupt(atMs: number): VoiceAuthorityTransition {
    const transition = this.publish([
      (state) => ({
        type: "interrupt/explicit",
        sessionId: state.sessionId,
        atMs,
        reason: "user_stop",
      }),
    ]);
    if (transition.accepted) {
      this.activeWireResponseId = null;
      this.audioIngressResponseId = null;
    }
    return transition;
  }

  enterReconnecting(atMs: number): VoiceAuthorityTransition {
    const transition = this.publish([
      (state) => ({
        type: "session/reconnecting",
        sessionId: state.sessionId,
        atMs,
      }),
    ]);
    if (transition.accepted) {
      this.activeWireTraceId = null;
      this.activeWireResponseId = null;
      this.audioIngressResponseId = null;
    }
    return transition;
  }

  close(atMs: number): VoiceAuthorityTransition {
    const transition = this.publish([
      (state) => ({
        type: "session/closed",
        sessionId: state.sessionId,
        atMs,
      }),
    ]);
    if (transition.accepted) {
      this.activeWireTraceId = null;
      this.activeWireResponseId = null;
      this.audioIngressResponseId = null;
    }
    return transition;
  }

  acceptMergeTimer(
    turnId: TurnId,
    turnRevision: number,
    atMs: number,
  ): VoiceAuthorityTransition {
    return this.publish([
      (state) => ({
        type: "timer/merge_elapsed",
        sessionId: state.sessionId,
        atMs,
        turnId,
        turnRevision,
      }),
    ]);
  }

  acceptsResponseControlTrace(traceId: string | undefined): boolean {
    return traceId === undefined || this.isCurrentWireTrace(traceId);
  }

  isPlaybackEffectAuthorized(
    transition: VoiceAuthorityTransition,
    responseId: ResponseId,
  ): boolean {
    const owner = this.playbackOwner;
    return Boolean(
      owner &&
        owner.epoch === this.authorityEpoch &&
        owner.responseId === responseId &&
        this.isTransitionCurrent(transition),
    );
  }

  acknowledgePlaybackFlush(
    transition: VoiceAuthorityTransition,
    responseId: ResponseId,
  ): boolean {
    if (!this.isTransitionCurrent(transition)) return false;
    if (this.playbackOwner?.responseId !== responseId) return false;
    this.playbackOwner = null;
    return true;
  }

  isPlaybackFlushAuthorized(
    transition: VoiceAuthorityTransition,
    responseId: ResponseId,
  ): boolean {
    return Boolean(
      this.isTransitionCurrent(transition) &&
        (!this.playbackOwner || this.playbackOwner.responseId === responseId),
    );
  }

  private transcriptSteps(
    atMs: number,
    allowUnspoken: boolean,
  ): EventFactory[] {
    const state = this.coordinator;
    if (!state) return [];
    const turnNeedsSpeechConfirmation =
      !state.turn ||
      state.turn.stage === "semantic" ||
      state.turn.stage === "sealed" ||
      state.response !== null;
    const turnNeedsResume = state.turn?.stage === "eot_tentative";
    const steps: EventFactory[] = [];
    if (turnNeedsSpeechConfirmation || turnNeedsResume) {
      const attemptId = state.speechAttempt?.id;
      steps.push((current) => ({
        type: "speech/confirmed",
        sessionId: current.sessionId,
        atMs,
        ...(attemptId ? { speechAttemptId: attemptId } : {}),
        continuation: "auto",
      }));
    } else if (!allowUnspoken && state.turn?.stage !== "transcribing") {
      return [];
    }
    steps.push((current) => ({
      type: "transcript/revised",
      sessionId: current.sessionId,
      atMs,
      turnId: current.turn?.id as TurnId,
      transcriptRevision: (current.turn?.transcriptRevision ?? 0) + 1,
    }));
    return steps;
  }

  private bindWireResponse(traceId: string): void {
    const responseId = this.coordinator?.response?.id ?? null;
    this.activeWireTraceId = traceId;
    this.activeWireResponseId = responseId;
    this.audioIngressResponseId = null;
  }

  private currentWireResponse(traceId: string): ResponseId | null {
    const state = this.coordinator;
    const responseId = this.activeWireResponseId;
    return this.activeWireTraceId === traceId &&
      responseId &&
      state &&
      isCurrentResponse(state, responseId)
      ? responseId
      : null;
  }

  private isCurrentWireTrace(traceId: string): boolean {
    return this.activeWireTraceId === traceId;
  }

  private publish(
    factories: readonly EventFactory[],
  ): VoiceAuthorityTransition {
    const current = this.coordinator;
    if (!current || factories.length === 0) {
      return this.noop(false, "invalid_state");
    }
    let draft = current;
    const effects: TurnCoordinatorEffect[] = [];
    for (const factory of factories) {
      const transition = reduceTurnCoordinator(draft, factory(draft));
      if (!transition.accepted) {
        return this.noop(false, transition.rejection ?? "invalid_state");
      }
      draft = transition.state;
      effects.push(...transition.effects);
    }
    this.coordinator = draft;
    this.authorityRevision += 1;
    return {
      accepted: true,
      effects,
      ticket: this.ticket(),
    };
  }

  private noop(
    accepted: boolean,
    rejection?: VoiceAuthorityTransition["rejection"],
  ): VoiceAuthorityTransition {
    return {
      accepted,
      effects: [],
      ticket: this.coordinator ? this.ticket() : null,
      ...(rejection ? { rejection } : {}),
    };
  }

  private ticket(): VoiceSessionAuthorityTicket {
    const state = this.coordinator;
    if (!state) throw new Error("voice session authority is not initialized");
    return {
      epoch: this.authorityEpoch,
      revision: this.authorityRevision,
      sessionId: state.sessionId,
    };
  }
}
