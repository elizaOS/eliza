import {
  createTurnCoordinatorState,
  isCurrentResponse,
  type ResponseId,
  reduceTurnCoordinator,
  type SpeechAttemptId,
  type TaskId,
  type TurnCoordinatorEffect,
  type TurnCoordinatorEvent,
  type TurnCoordinatorState,
  type TurnCoordinatorTransition,
  type TurnDisposition,
  type TurnId,
} from "@elizaos/shared/voice/turn-coordinator";

type LocalTurnCoordinatorEvent = TurnCoordinatorEvent extends infer Event
  ? Event extends TurnCoordinatorEvent
    ? Omit<Event, "sessionId" | "atMs">
    : never
  : never;

/**
 * Immutable capability for one response owned by a cloud voice session.
 *
 * `traceId` remains the protocol-v1/public correlation id. `responseId` is the
 * coordinator's exact internal authority and must guard every asynchronous
 * model, display, synthesis, and audio callback.
 */
export interface VoiceResponseLease {
  readonly traceId: string;
  readonly responseId: ResponseId;
  readonly turnId: TurnId;
  readonly turnRevision: number;
}

export interface VoiceSessionTurnAuthorityOptions {
  readonly sessionId: string;
  readonly now?: () => number;
  /**
   * Seal a semantic turn immediately after commit when the upstream adapter has
   * already completed its own false-EOT repair window.
   */
  readonly sealCommittedTurns?: boolean;
  /**
   * Observability/effect seam. The adapter publishes `state` before invoking
   * this callback, so delayed providers can never regain authority while an
   * effect is being interpreted.
   */
  readonly onEffect?: (
    effect: TurnCoordinatorEffect,
    authority: VoiceSessionTurnAuthority,
  ) => void;
}

/**
 * Server-side owner of the shared realtime turn reducer.
 *
 * The browser may project this state for local playout latency, but only a
 * lease minted here authorizes cloud response callbacks. The adapter performs
 * no provider I/O and intentionally leaves protocol-v1 `traceId` unchanged.
 */
export class VoiceSessionTurnAuthority {
  private coordinatorState: TurnCoordinatorState;
  private readonly now: () => number;
  private readonly sealCommittedTurns: boolean;
  private readonly onEffect?: VoiceSessionTurnAuthorityOptions["onEffect"];
  private readonly leasesByResponseId = new Map<
    ResponseId,
    VoiceResponseLease
  >();
  /** Stable bridge call ids to exact coordinator task capabilities. */
  private readonly taskIdsByCallId = new Map<string, TaskId>();

  constructor(options: VoiceSessionTurnAuthorityOptions) {
    this.now = options.now ?? Date.now;
    this.sealCommittedTurns = options.sealCommittedTurns === true;
    this.onEffect = options.onEffect;
    this.coordinatorState = createTurnCoordinatorState({
      sessionId: options.sessionId,
      atMs: this.now(),
    });
  }

  get state(): TurnCoordinatorState {
    return this.coordinatorState;
  }

  get currentLease(): VoiceResponseLease | null {
    const responseId = this.coordinatorState.response?.id;
    return responseId
      ? (this.leasesByResponseId.get(responseId) ?? null)
      : null;
  }

  isCurrent(lease: VoiceResponseLease): boolean {
    return (
      this.leasesByResponseId.get(lease.responseId) === lease &&
      isCurrentResponse(this.coordinatorState, lease.responseId)
    );
  }

  /** Record a browser/local provisional acoustic start without revoking. */
  provisionalSpeechStarted(): SpeechAttemptId | null {
    const transition = this.dispatch({ type: "speech/provisional_started" });
    return transition.accepted
      ? (transition.state.speechAttempt?.id ?? null)
      : null;
  }

  /** Reject the current provisional start, retaining the exact response. */
  rejectProvisionalSpeech(): boolean {
    const speechAttemptId = this.coordinatorState.speechAttempt?.id;
    if (!speechAttemptId) return false;
    return this.dispatch({
      type: "speech/provisional_rejected",
      speechAttemptId,
    }).accepted;
  }

  /**
   * Confirm caller speech and revoke the prior response exactly once. Within
   * the reducer's bounded merge window this resumes the same turn revision;
   * otherwise it opens a fresh user turn.
   */
  confirmSpeech(
    continuation: "auto" | "new_turn" = "auto",
  ): VoiceResponseLease | null {
    const revoked = this.currentLease;
    const speechAttemptId = this.coordinatorState.speechAttempt?.id;
    const transition = this.dispatch({
      type: "speech/confirmed",
      ...(speechAttemptId ? { speechAttemptId } : {}),
      continuation,
    });
    return transition.accepted && revoked && !this.isCurrent(revoked)
      ? revoked
      : null;
  }

  /**
   * Commit a response-producing semantic turn and bind its internal response
   * identity to the existing protocol-v1 trace.
   */
  commitResponse(traceId: string): VoiceResponseLease {
    const transition = this.commit(traceId, "respond");
    const response = transition.state.response;
    const turn = transition.state.turn;
    if (!transition.accepted || !response || !turn) {
      throw new Error(
        `voice turn authority rejected response commit: ${transition.rejection ?? "missing_response"}`,
      );
    }
    const lease: VoiceResponseLease = Object.freeze({
      traceId,
      responseId: response.id,
      turnId: response.turnId,
      turnRevision: response.turnRevision,
    });
    this.leasesByResponseId.set(response.id, lease);
    return lease;
  }

  /** Commit a control/no-response turn, which intentionally mints no lease. */
  commitWithoutResponse(
    traceId: string,
    disposition: Exclude<TurnDisposition, "respond">,
  ): boolean {
    return this.commit(traceId, disposition).accepted;
  }

  markModelStarted(lease: VoiceResponseLease): boolean {
    if (!this.isCurrent(lease)) return false;
    return this.dispatch({
      type: "response/model_started",
      responseId: lease.responseId,
    }).accepted;
  }

  markSpeakingStarted(lease: VoiceResponseLease): boolean {
    if (!this.isCurrent(lease)) return false;
    return this.dispatch({
      type: "response/speaking_started",
      responseId: lease.responseId,
    }).accepted;
  }

  markAudioEnqueued(lease: VoiceResponseLease): boolean {
    if (!this.isCurrent(lease)) return false;
    return this.dispatch({
      type: "playback/enqueued",
      responseId: lease.responseId,
    }).accepted;
  }

  requestTask(
    lease: VoiceResponseLease,
    callId: string,
    policy: {
      lifetime: "response" | "durable";
      effect: "read_only" | "mutating";
      restartable: boolean;
    },
  ): boolean {
    if (!this.isCurrent(lease)) return false;
    const existingTaskId = this.taskIdsByCallId.get(callId);
    if (existingTaskId) {
      return Boolean(this.coordinatorState.tasks[existingTaskId]);
    }
    const previousTaskIds = new Set(Object.keys(this.coordinatorState.tasks));
    const transition = this.dispatch({
      type: "task/requested",
      responseId: lease.responseId,
      ...policy,
      // The exact canonical tool call id is the coordinator operation key.
      // `restartable` independently reflects whether the action declares safe
      // provider/store replay; non-idempotent mutations are never restarted.
      ...(policy.effect === "mutating" ? { idempotencyKey: callId } : {}),
    });
    if (!transition.accepted) return false;
    const task = Object.values(transition.state.tasks).find(
      (candidate) =>
        candidate.responseId === lease.responseId &&
        !previousTaskIds.has(candidate.id),
    );
    if (!task) return false;
    this.taskIdsByCallId.set(callId, task.id);
    return true;
  }

  markTaskCommitCrossed(callId: string): boolean {
    const taskId = this.taskIdsByCallId.get(callId);
    if (!taskId || !this.coordinatorState.tasks[taskId]) return false;
    return this.dispatch({ type: "task/commit_crossed", taskId }).accepted;
  }

  settleTask(callId: string): boolean {
    const taskId = this.taskIdsByCallId.get(callId);
    if (!taskId || !this.coordinatorState.tasks[taskId]) return false;
    return this.dispatch({ type: "task/settled", taskId }).accepted;
  }

  settle(
    lease: VoiceResponseLease,
    outcome: "spoken" | "displayed" | "no_response" | "error" | "stopped",
  ): boolean {
    if (!this.isCurrent(lease)) return false;
    return this.dispatch({
      type: "response/settled",
      responseId: lease.responseId,
      // The shared reducer distinguishes response settlement from the wire's
      // display-vs-speech delivery detail. Display-only is still a successful
      // response settlement, so normalize it to its successful terminal.
      outcome: outcome === "displayed" ? "spoken" : outcome,
    }).accepted;
  }

  explicitInterrupt(): VoiceResponseLease | null {
    const revoked = this.currentLease;
    const transition = this.dispatch({
      type: "interrupt/explicit",
      reason: "user_stop",
    });
    return transition.accepted && revoked && !this.isCurrent(revoked)
      ? revoked
      : null;
  }

  close(): VoiceResponseLease | null {
    const revoked = this.currentLease;
    const transition = this.dispatch({ type: "session/closed" });
    return transition.accepted && revoked && !this.isCurrent(revoked)
      ? revoked
      : null;
  }

  private commit(
    _traceId: string,
    disposition: TurnDisposition,
  ): TurnCoordinatorTransition {
    this.ensureTranscribingTurn();
    const turn = this.coordinatorState.turn;
    if (!turn) {
      throw new Error(
        "voice turn authority failed to open a transcribing turn",
      );
    }
    const transcriptRevision = turn.transcriptRevision + 1;
    const revised = this.dispatch({
      type: "transcript/revised",
      turnId: turn.id,
      transcriptRevision,
    });
    if (!revised.accepted) return revised;
    const committed = this.dispatch({
      type: "turn/commit",
      turnId: turn.id,
      transcriptRevision,
      disposition,
    });
    const committedTurn = this.coordinatorState.turn;
    if (
      committed.accepted &&
      this.sealCommittedTurns &&
      committedTurn?.stage === "semantic" &&
      committedTurn.mergeDeadlineMs !== null
    ) {
      return this.dispatchAt(
        {
          type: "timer/merge_elapsed",
          turnId: committedTurn.id,
          turnRevision: committedTurn.revision,
        },
        committedTurn.mergeDeadlineMs,
      );
    }
    return committed;
  }

  private ensureTranscribingTurn(): void {
    const stage = this.coordinatorState.turn?.stage;
    if (stage === "transcribing" || stage === "eot_tentative") return;
    const transition = this.dispatch({
      type: "speech/confirmed",
      continuation: "new_turn",
    });
    if (!transition.accepted) {
      throw new Error(
        `voice turn authority failed to open turn: ${transition.rejection ?? "unknown"}`,
      );
    }
  }

  private dispatch(
    event: LocalTurnCoordinatorEvent,
  ): TurnCoordinatorTransition {
    return this.dispatchAt(event, this.now());
  }

  private dispatchAt(
    event: LocalTurnCoordinatorEvent,
    atMs: number,
  ): TurnCoordinatorTransition {
    const transition = reduceTurnCoordinator(this.coordinatorState, {
      ...event,
      sessionId: this.coordinatorState.sessionId,
      atMs,
    } as TurnCoordinatorEvent);
    if (!transition.accepted) return transition;

    // Publish first. Every effect observer sees the new exact authority.
    this.coordinatorState = transition.state;
    for (const effect of transition.effects) {
      this.onEffect?.(effect, this);
    }
    return transition;
  }
}
