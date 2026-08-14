/**
 * Provider-neutral authority for one realtime voice session.
 *
 * The coordinator is deliberately a pure reducer. It owns identities,
 * revisions, and cancellation policy, but performs no I/O and creates no
 * timers or AbortControllers. Callers MUST publish `transition.state` before
 * interpreting `transition.effects`; that ordering makes exact ID guards the
 * authority even when a provider ignores or delays cancellation.
 */

declare const turnIdBrand: unique symbol;
declare const responseIdBrand: unique symbol;
declare const taskIdBrand: unique symbol;
declare const speechAttemptIdBrand: unique symbol;
declare const tentativeEotIdBrand: unique symbol;

export type TurnId = string & { readonly [turnIdBrand]: true };
export type ResponseId = string & { readonly [responseIdBrand]: true };
export type TaskId = string & { readonly [taskIdBrand]: true };
export type SpeechAttemptId = string & {
  readonly [speechAttemptIdBrand]: true;
};
export type TentativeEotId = string & {
  readonly [tentativeEotIdBrand]: true;
};

export interface TurnCoordinatorPolicy {
  /** How long local playback may remain provisionally paused. */
  speechConfirmationTimeoutMs: number;
  /** Time after semantic EOT in which continuation repairs the same turn. */
  eotMergeWindowMs: number;
}

export const DEFAULT_TURN_COORDINATOR_POLICY: Readonly<TurnCoordinatorPolicy> =
  Object.freeze({
    speechConfirmationTimeoutMs: 350,
    eotMergeWindowMs: 900,
  });

export type TurnCoordinatorLifecycle =
  | "listening"
  | "degraded"
  | "reconnecting"
  | "closed";

export type TurnCommitStage =
  | "transcribing"
  | "eot_tentative"
  | "semantic"
  | "sealed";

export type TurnDisposition = "respond" | "no_response" | "control_stop";

export interface CoordinatedResponseSummary {
  id: ResponseId;
  audibleStarted: boolean;
  /** Browser has exact queued audio for this response that is not yet drained. */
  playoutPending: boolean;
  settled: boolean;
}

export interface CoordinatedTurn {
  id: TurnId;
  revision: number;
  transcriptRevision: number;
  stage: TurnCommitStage;
  disposition: TurnDisposition | null;
  tentativeEotId: TentativeEotId | null;
  committedAtMs: number | null;
  mergeDeadlineMs: number | null;
  /** Prior semantically committed revision retained until replacement commit. */
  supersedesRevision: number | null;
  lastResponse: CoordinatedResponseSummary | null;
}

export type CoordinatedResponseStatus = "pending" | "thinking" | "speaking";

export interface CoordinatedResponse {
  id: ResponseId;
  turnId: TurnId;
  turnRevision: number;
  purpose: "answer" | "progress" | "repair";
  status: CoordinatedResponseStatus;
}

export interface CoordinatedTask {
  id: TaskId;
  turnId: TurnId;
  turnRevision: number;
  responseId: ResponseId;
  lifetime: "response" | "durable";
  effect: "read_only" | "mutating";
  restartable: boolean;
  idempotencyKey: string | null;
  status: "deferred" | "running" | "detached" | "commit_crossed";
}

export type TurnInterruptionReason =
  | "confirmed_speech"
  | "false_cutoff"
  | "explicit"
  | "degraded"
  | "reconnect"
  | "session_closed";

export interface TurnCoordinatorState {
  readonly schemaVersion: 1;
  readonly sessionId: string;
  readonly lifecycle: TurnCoordinatorLifecycle;
  readonly policy: Readonly<TurnCoordinatorPolicy>;
  /** Authoritative ingress clock. Reducers never call Date.now(). */
  readonly lastAtMs: number;
  readonly counters: Readonly<{
    turn: number;
    response: number;
    task: number;
    speechAttempt: number;
    eot: number;
  }>;
  readonly speechAttempt: Readonly<{
    id: SpeechAttemptId;
    pausedResponseId: ResponseId;
    deadlineMs: number;
  }> | null;
  readonly turn: Readonly<CoordinatedTurn> | null;
  /** Only this exact response may produce new model/TTS/output callbacks. */
  readonly response: Readonly<CoordinatedResponse> | null;
  readonly tasks: Readonly<Record<string, Readonly<CoordinatedTask>>>;
  readonly pendingRepair: Readonly<{
    turnId: TurnId;
    interruptedResponseId: ResponseId;
    audibleCutoff: true;
  }> | null;
  /** UI projection only; never grants callback authority. */
  readonly interruption: Readonly<{
    responseId: ResponseId;
    reason: TurnInterruptionReason;
    atMs: number;
  }> | null;
}

interface CoordinatorEventBase {
  sessionId: string;
  atMs: number;
}

export type TurnCoordinatorEvent =
  | (CoordinatorEventBase & { type: "speech/provisional_started" })
  | (CoordinatorEventBase & {
      type: "speech/provisional_rejected" | "timer/speech_confirmation_elapsed";
      speechAttemptId: SpeechAttemptId;
    })
  | (CoordinatorEventBase & {
      type: "speech/confirmed";
      speechAttemptId?: SpeechAttemptId;
      continuation: "auto" | "new_turn";
    })
  | (CoordinatorEventBase & {
      type: "transcript/revised";
      turnId: TurnId;
      transcriptRevision: number;
    })
  | (CoordinatorEventBase & {
      type: "eot/tentative";
      turnId: TurnId;
      transcriptRevision: number;
    })
  | (CoordinatorEventBase & {
      type: "turn/resumed";
      turnId: TurnId;
      tentativeEotId?: TentativeEotId;
    })
  | (CoordinatorEventBase & {
      type: "turn/commit";
      turnId: TurnId;
      transcriptRevision: number;
      disposition: TurnDisposition;
    })
  | (CoordinatorEventBase & {
      type: "timer/merge_elapsed";
      turnId: TurnId;
      turnRevision: number;
    })
  | (CoordinatorEventBase & {
      type: "response/model_started" | "response/speaking_started";
      responseId: ResponseId;
    })
  | (CoordinatorEventBase & {
      /** `drained` is terminal for this response, not a transient queue underrun. */
      type: "playback/enqueued" | "playback/drained";
      responseId: ResponseId;
    })
  | (CoordinatorEventBase & {
      type: "response/settled";
      responseId: ResponseId;
      outcome: "spoken" | "no_response" | "error" | "stopped";
    })
  | (CoordinatorEventBase & {
      type: "response/retry";
      turnId: TurnId;
      turnRevision: number;
    })
  | (CoordinatorEventBase & {
      type: "task/requested";
      responseId: ResponseId;
      lifetime: "response" | "durable";
      effect: "read_only" | "mutating";
      restartable: boolean;
      idempotencyKey?: string;
    })
  | (CoordinatorEventBase & {
      type: "task/commit_crossed" | "task/settled";
      taskId: TaskId;
    })
  | (CoordinatorEventBase & {
      type: "interrupt/explicit";
      reason: "user_stop" | "session_close";
    })
  | (CoordinatorEventBase & {
      type:
        | "session/listening"
        | "session/degraded"
        | "session/reconnecting"
        | "session/closed";
    });

export type TurnCoordinatorEffect =
  | { type: "timer/arm"; key: string; deadlineMs: number }
  | { type: "timer/cancel"; key: string }
  | { type: "playback/pause"; responseId: ResponseId }
  | { type: "playback/resume"; responseId: ResponseId }
  | { type: "playback/flush"; responseId: ResponseId }
  | {
      type: "tts/cancel";
      responseId: ResponseId;
      reason: TurnInterruptionReason;
    }
  | {
      type: "model/abort";
      responseId: ResponseId;
      reason: TurnInterruptionReason;
    }
  | { type: "output/retract"; responseId: ResponseId }
  | {
      type: "progress/cancel";
      responseId: ResponseId;
      reason: TurnInterruptionReason;
    }
  | {
      type: "turn/commit_revision";
      turnId: TurnId;
      revision: number;
      supersedesRevision: number | null;
      disposition: TurnDisposition;
    }
  | {
      type: "turn/end";
      turnId: TurnId;
      revision: number;
      outcome: "no_response" | "stopped";
    }
  | {
      type: "response/start";
      responseId: ResponseId;
      turnId: TurnId;
      turnRevision: number;
    }
  | { type: "task/start"; taskId: TaskId }
  | { type: "task/abort"; taskId: TaskId }
  | { type: "task/detach"; taskId: TaskId }
  | { type: "task/report_actual_state"; taskId: TaskId }
  | {
      type: "task/result_available";
      taskId: TaskId;
      responseId: ResponseId;
      delivery: "response_router" | "background_visual";
    }
  | {
      type: "repair/queue";
      turnId: TurnId;
      interruptedResponseId: ResponseId;
      speakAfterNextEot: true;
    };

export type TurnCoordinatorRejection =
  | "session_mismatch"
  | "session_closed"
  | "invalid_state"
  | "no_interruptible_response"
  | "speech_attempt_active"
  | "stale_speech_attempt"
  | "stale_turn"
  | "stale_transcript_revision"
  | "stale_response"
  | "response_active"
  | "stale_task"
  | "task_not_mutating"
  | "mutation_requires_idempotency_key"
  | "mutation_not_sealed"
  | "merge_window_elapsed"
  | "timer_not_due"
  | "turn_does_not_respond";

export interface TurnCoordinatorTransition {
  readonly state: TurnCoordinatorState;
  readonly effects: readonly TurnCoordinatorEffect[];
  readonly accepted: boolean;
  readonly rejection?: TurnCoordinatorRejection;
}

function requireFiniteAtMs(atMs: number): void {
  if (!Number.isFinite(atMs)) {
    throw new TypeError("atMs must be finite");
  }
}

function requirePositiveDuration(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${name} must be a finite positive number`);
  }
  return value;
}

function makeId<T extends string>(
  sessionId: string,
  kind: string,
  sequence: number,
): T {
  return `${sessionId}:${kind}:${sequence}` as T;
}

function timerKey(kind: "speech" | "merge", id: string): string {
  return `${kind}:${id}`;
}

function accepted(
  state: TurnCoordinatorState,
  effects: readonly TurnCoordinatorEffect[] = [],
): TurnCoordinatorTransition {
  return { state, effects, accepted: true };
}

function rejected(
  state: TurnCoordinatorState,
  rejection: TurnCoordinatorRejection,
): TurnCoordinatorTransition {
  return { state, effects: [], accepted: false, rejection };
}

function createTurn(state: TurnCoordinatorState): {
  state: TurnCoordinatorState;
  turn: CoordinatedTurn;
} {
  const sequence = state.counters.turn + 1;
  const turn: CoordinatedTurn = {
    id: makeId<TurnId>(state.sessionId, "turn", sequence),
    revision: 0,
    transcriptRevision: 0,
    stage: "transcribing",
    disposition: null,
    tentativeEotId: null,
    committedAtMs: null,
    mergeDeadlineMs: null,
    supersedesRevision: null,
    lastResponse: null,
  };
  return {
    turn,
    state: {
      ...state,
      counters: { ...state.counters, turn: sequence },
      turn,
    },
  };
}

function createResponse(
  state: TurnCoordinatorState,
  turn: CoordinatedTurn,
): {
  state: TurnCoordinatorState;
  response: CoordinatedResponse;
  turn: CoordinatedTurn;
} {
  const sequence = state.counters.response + 1;
  const response: CoordinatedResponse = {
    id: makeId<ResponseId>(state.sessionId, "response", sequence),
    turnId: turn.id,
    turnRevision: turn.revision,
    purpose: "answer",
    status: "pending",
  };
  const nextTurn: CoordinatedTurn = {
    ...turn,
    lastResponse: {
      id: response.id,
      audibleStarted: false,
      playoutPending: false,
      settled: false,
    },
  };
  return {
    response,
    turn: nextTurn,
    state: {
      ...state,
      counters: { ...state.counters, response: sequence },
      turn: nextTurn,
      response,
      interruption: null,
    },
  };
}

function isKnownResponse(
  state: TurnCoordinatorState,
  responseId: ResponseId,
): boolean {
  return (
    state.response?.id === responseId ||
    (state.turn?.lastResponse?.id === responseId &&
      state.turn.lastResponse.playoutPending)
  );
}

function pendingPlayoutResponseId(
  state: TurnCoordinatorState,
): ResponseId | null {
  const lastResponse = state.turn?.lastResponse;
  return lastResponse?.playoutPending ? lastResponse.id : null;
}

function clearPendingPlayout(
  state: TurnCoordinatorState,
  responseId: ResponseId | null,
): TurnCoordinatorState {
  if (
    !responseId ||
    state.turn?.lastResponse?.id !== responseId ||
    !state.turn.lastResponse.playoutPending
  ) {
    return state;
  }
  return {
    ...state,
    turn: {
      ...state.turn,
      lastResponse: { ...state.turn.lastResponse, playoutPending: false },
    },
  };
}

interface RevokedResponse {
  state: TurnCoordinatorState;
  effects: TurnCoordinatorEffect[];
  responseId: ResponseId | null;
  audibleStarted: boolean;
}

function revokeResponse(
  state: TurnCoordinatorState,
  reason: TurnInterruptionReason,
  atMs: number,
): RevokedResponse {
  const response = state.response;
  if (!response) {
    return { state, effects: [], responseId: null, audibleStarted: false };
  }

  const effects: TurnCoordinatorEffect[] = [
    { type: "playback/flush", responseId: response.id },
    { type: "tts/cancel", responseId: response.id, reason },
    { type: "model/abort", responseId: response.id, reason },
    { type: "output/retract", responseId: response.id },
    { type: "progress/cancel", responseId: response.id, reason },
  ];
  const nextTasks: Record<string, Readonly<CoordinatedTask>> = {
    ...state.tasks,
  };

  for (const task of Object.values(state.tasks)) {
    if (task.responseId !== response.id) continue;
    if (task.status === "deferred") {
      // No external task exists yet, so revocation only drops the lease.
      delete nextTasks[task.id];
      continue;
    }
    if (task.effect === "mutating") {
      if (task.status === "commit_crossed") {
        nextTasks[task.id] = { ...task, status: "detached" };
        effects.push(
          { type: "task/detach", taskId: task.id },
          { type: "task/report_actual_state", taskId: task.id },
        );
      } else {
        // Mutation safety dominates lifetime: before the external commit point
        // even a nominally durable task must stop, not continue detached.
        delete nextTasks[task.id];
        effects.push({ type: "task/abort", taskId: task.id });
      }
      continue;
    }
    if (task.lifetime === "durable" || !task.restartable) {
      nextTasks[task.id] = { ...task, status: "detached" };
      effects.push({ type: "task/detach", taskId: task.id });
      continue;
    }
    delete nextTasks[task.id];
    effects.push({ type: "task/abort", taskId: task.id });
  }

  const audibleStarted =
    state.turn?.lastResponse?.id === response.id
      ? state.turn.lastResponse.audibleStarted
      : response.status === "speaking";
  return {
    state: {
      ...clearPendingPlayout(state, response.id),
      response: null,
      tasks: nextTasks,
      interruption: { responseId: response.id, reason, atMs },
    },
    effects,
    responseId: response.id,
    audibleStarted,
  };
}

function resumeTurn(
  state: TurnCoordinatorState,
  atMs: number,
): TurnCoordinatorTransition {
  const turn = state.turn;
  if (!turn) return rejected(state, "stale_turn");
  if (turn.stage === "transcribing") {
    return rejected(state, "invalid_state");
  }
  if (turn.stage === "sealed") {
    return rejected(state, "merge_window_elapsed");
  }
  if (
    turn.stage === "semantic" &&
    (turn.mergeDeadlineMs === null || atMs > turn.mergeDeadlineMs)
  ) {
    return rejected(state, "merge_window_elapsed");
  }

  const revoked = revokeResponse(state, "false_cutoff", atMs);
  const supersedesRevision =
    turn.stage === "semantic" ? turn.revision : turn.supersedesRevision;
  const pendingPlayoutId = pendingPlayoutResponseId(state);
  const nextTurn: CoordinatedTurn = {
    ...turn,
    revision: turn.revision + 1,
    stage: "transcribing",
    disposition: null,
    tentativeEotId: null,
    committedAtMs: null,
    mergeDeadlineMs: null,
    supersedesRevision,
    lastResponse:
      turn.lastResponse &&
      (revoked.responseId === turn.lastResponse.id ||
        pendingPlayoutId === turn.lastResponse.id)
        ? { ...turn.lastResponse, playoutPending: false }
        : turn.lastResponse,
  };
  const interruptedResponseId = revoked.responseId ?? pendingPlayoutId;
  const audibleCutoff =
    revoked.audibleStarted ||
    (pendingPlayoutId !== null && turn.lastResponse?.audibleStarted === true);
  const pendingRepair =
    interruptedResponseId && audibleCutoff
      ? {
          turnId: turn.id,
          interruptedResponseId,
          audibleCutoff: true as const,
        }
      : null;
  const effects = [...revoked.effects];
  if (!revoked.responseId && interruptedResponseId) {
    // Model/TTS may already have settled while the browser still owns a queued
    // playout tail. That tail keeps the exact response identity and must be
    // flushed on a repaired cutoff, without pretending an upstream provider is
    // still cancellable.
    effects.push(
      { type: "playback/flush", responseId: interruptedResponseId },
      { type: "output/retract", responseId: interruptedResponseId },
    );
  }
  return accepted(
    {
      ...revoked.state,
      lastAtMs: atMs,
      turn: nextTurn,
      speechAttempt: null,
      pendingRepair,
    },
    effects,
  );
}

function settleTasksForResponse(
  state: TurnCoordinatorState,
  responseId: ResponseId,
): { tasks: TurnCoordinatorState["tasks"]; effects: TurnCoordinatorEffect[] } {
  const tasks: Record<string, Readonly<CoordinatedTask>> = { ...state.tasks };
  const effects: TurnCoordinatorEffect[] = [];
  for (const task of Object.values(state.tasks)) {
    if (task.responseId !== responseId) continue;
    if (task.status === "deferred") {
      delete tasks[task.id];
    } else if (
      task.lifetime === "durable" ||
      task.status === "commit_crossed" ||
      (task.effect === "read_only" && !task.restartable)
    ) {
      tasks[task.id] = { ...task, status: "detached" };
      effects.push({ type: "task/detach", taskId: task.id });
      if (task.status === "commit_crossed") {
        effects.push({ type: "task/report_actual_state", taskId: task.id });
      }
    } else {
      delete tasks[task.id];
      effects.push({ type: "task/abort", taskId: task.id });
    }
  }
  return { tasks, effects };
}

export function createTurnCoordinatorState(input: {
  sessionId: string;
  atMs: number;
  policy?: Partial<TurnCoordinatorPolicy>;
}): TurnCoordinatorState {
  if (typeof input.sessionId !== "string" || input.sessionId.trim() === "") {
    throw new TypeError("sessionId must be a non-empty string");
  }
  requireFiniteAtMs(input.atMs);
  const policy = Object.freeze({
    speechConfirmationTimeoutMs: requirePositiveDuration(
      "speechConfirmationTimeoutMs",
      input.policy?.speechConfirmationTimeoutMs ??
        DEFAULT_TURN_COORDINATOR_POLICY.speechConfirmationTimeoutMs,
    ),
    eotMergeWindowMs: requirePositiveDuration(
      "eotMergeWindowMs",
      input.policy?.eotMergeWindowMs ??
        DEFAULT_TURN_COORDINATOR_POLICY.eotMergeWindowMs,
    ),
  });
  return {
    schemaVersion: 1,
    sessionId: input.sessionId,
    lifecycle: "listening",
    policy,
    lastAtMs: input.atMs,
    counters: {
      turn: 0,
      response: 0,
      task: 0,
      speechAttempt: 0,
      eot: 0,
    },
    speechAttempt: null,
    turn: null,
    response: null,
    tasks: {},
    pendingRepair: null,
    interruption: null,
  };
}

export function isCurrentResponse(
  state: TurnCoordinatorState,
  responseId: ResponseId,
): boolean {
  return state.lifecycle === "listening" && state.response?.id === responseId;
}

export function isTaskCommitAuthorized(
  state: TurnCoordinatorState,
  taskId: TaskId,
): boolean {
  const task = state.tasks[taskId];
  return Boolean(
    task &&
      task.effect === "mutating" &&
      task.status === "running" &&
      task.idempotencyKey &&
      state.turn?.id === task.turnId &&
      state.turn.revision === task.turnRevision &&
      state.turn.stage === "sealed" &&
      state.response?.id === task.responseId,
  );
}

export function isTaskSpeechAuthorized(
  state: TurnCoordinatorState,
  taskId: TaskId,
): boolean {
  const task = state.tasks[taskId];
  return Boolean(
    task &&
      task.status !== "detached" &&
      isCurrentResponse(state, task.responseId),
  );
}

export type ProjectedTurnPhase =
  | "listening"
  | "speech_tentative"
  | "transcribing"
  | "eot_tentative"
  | "committed"
  | "thinking"
  | "speaking"
  | "interrupting"
  | "degraded"
  | "reconnecting"
  | "closed";

export function projectTurnPhase(
  state: TurnCoordinatorState,
): ProjectedTurnPhase {
  if (state.lifecycle !== "listening") return state.lifecycle;
  if (state.speechAttempt) return "speech_tentative";
  if (state.turn?.stage === "transcribing") return "transcribing";
  if (state.turn?.stage === "eot_tentative") return "eot_tentative";
  if (state.response?.status === "speaking") return "speaking";
  if (state.response?.status === "thinking") return "thinking";
  if (state.response?.status === "pending") return "committed";
  if (state.interruption) return "interrupting";
  return "listening";
}

export function reduceTurnCoordinator(
  state: TurnCoordinatorState,
  event: TurnCoordinatorEvent,
): TurnCoordinatorTransition {
  if (event.sessionId !== state.sessionId) {
    return rejected(state, "session_mismatch");
  }
  requireFiniteAtMs(event.atMs);
  if (event.atMs < state.lastAtMs) {
    // Event identity and revision are authoritative. Provider/browser
    // timestamps are observations and can arrive out of order, so normalize
    // them instead of allowing an older clock sample to wedge cancellation or
    // settlement. This recurses once because the normalized value is equal.
    return reduceTurnCoordinator(state, {
      ...event,
      atMs: state.lastAtMs,
    } as TurnCoordinatorEvent);
  }
  if (state.lifecycle === "closed") {
    return rejected(state, "session_closed");
  }

  switch (event.type) {
    case "speech/provisional_started": {
      if (state.lifecycle !== "listening") {
        return rejected(state, "invalid_state");
      }
      if (state.speechAttempt) {
        return rejected(state, "speech_attempt_active");
      }
      const responseId = state.response?.id ?? pendingPlayoutResponseId(state);
      if (!responseId) return rejected(state, "no_interruptible_response");
      const sequence = state.counters.speechAttempt + 1;
      const id = makeId<SpeechAttemptId>(
        state.sessionId,
        "speech-attempt",
        sequence,
      );
      const deadlineMs = event.atMs + state.policy.speechConfirmationTimeoutMs;
      return accepted(
        {
          ...state,
          lastAtMs: event.atMs,
          counters: { ...state.counters, speechAttempt: sequence },
          speechAttempt: { id, pausedResponseId: responseId, deadlineMs },
        },
        [
          { type: "playback/pause", responseId },
          {
            type: "timer/arm",
            key: timerKey("speech", id),
            deadlineMs,
          },
        ],
      );
    }

    case "speech/provisional_rejected":
    case "timer/speech_confirmation_elapsed": {
      const attempt = state.speechAttempt;
      if (!attempt || attempt.id !== event.speechAttemptId) {
        return rejected(state, "stale_speech_attempt");
      }
      if (
        event.type === "timer/speech_confirmation_elapsed" &&
        event.atMs < attempt.deadlineMs
      ) {
        return rejected(state, "timer_not_due");
      }
      const effects: TurnCoordinatorEffect[] = [
        { type: "timer/cancel", key: timerKey("speech", attempt.id) },
      ];
      if (isKnownResponse(state, attempt.pausedResponseId)) {
        effects.push({
          type: "playback/resume",
          responseId: attempt.pausedResponseId,
        });
      }
      return accepted(
        {
          ...state,
          lastAtMs: event.atMs,
          speechAttempt: null,
        },
        effects,
      );
    }

    case "speech/confirmed": {
      const attempt = state.speechAttempt;
      if (
        event.speechAttemptId !== undefined &&
        event.speechAttemptId !== attempt?.id
      ) {
        return rejected(state, "stale_speech_attempt");
      }
      const timerEffects: TurnCoordinatorEffect[] = attempt
        ? [
            {
              type: "timer/cancel",
              key: timerKey("speech", attempt.id),
            },
          ]
        : [];
      const turn = state.turn;
      const shouldResume =
        event.continuation === "auto" &&
        turn !== null &&
        (turn.stage === "eot_tentative" ||
          (turn.stage === "semantic" &&
            turn.mergeDeadlineMs !== null &&
            event.atMs <= turn.mergeDeadlineMs));

      if (shouldResume) {
        const transition = resumeTurn(
          { ...state, speechAttempt: null },
          event.atMs,
        );
        return transition.accepted
          ? accepted(transition.state, [...timerEffects, ...transition.effects])
          : transition;
      }

      const pendingPlayoutId = pendingPlayoutResponseId(state);
      const revoked = revokeResponse(state, "confirmed_speech", event.atMs);
      const opened = createTurn({
        ...clearPendingPlayout(revoked.state, pendingPlayoutId),
        speechAttempt: null,
        pendingRepair: null,
      });
      return accepted(
        {
          ...opened.state,
          lastAtMs: event.atMs,
          turn: opened.turn,
        },
        [
          ...timerEffects,
          ...(!revoked.responseId && (attempt || pendingPlayoutId)
            ? [
                {
                  type: "playback/flush" as const,
                  responseId:
                    attempt?.pausedResponseId ??
                    (pendingPlayoutId as ResponseId),
                },
                {
                  type: "output/retract" as const,
                  responseId:
                    attempt?.pausedResponseId ??
                    (pendingPlayoutId as ResponseId),
                },
              ]
            : []),
          ...revoked.effects,
        ],
      );
    }

    case "transcript/revised": {
      const turn = state.turn;
      if (!turn || turn.id !== event.turnId) {
        return rejected(state, "stale_turn");
      }
      if (turn.stage !== "transcribing" && turn.stage !== "eot_tentative") {
        return rejected(state, "invalid_state");
      }
      if (event.transcriptRevision <= turn.transcriptRevision) {
        return rejected(state, "stale_transcript_revision");
      }
      return accepted({
        ...state,
        lastAtMs: event.atMs,
        turn: { ...turn, transcriptRevision: event.transcriptRevision },
        interruption: null,
      });
    }

    case "eot/tentative": {
      const turn = state.turn;
      if (!turn || turn.id !== event.turnId) {
        return rejected(state, "stale_turn");
      }
      if (turn.stage !== "transcribing") {
        return rejected(state, "invalid_state");
      }
      if (event.transcriptRevision !== turn.transcriptRevision) {
        return rejected(state, "stale_transcript_revision");
      }
      const sequence = state.counters.eot + 1;
      const tentativeEotId = makeId<TentativeEotId>(
        state.sessionId,
        "eot",
        sequence,
      );
      return accepted({
        ...state,
        lastAtMs: event.atMs,
        counters: { ...state.counters, eot: sequence },
        turn: { ...turn, stage: "eot_tentative", tentativeEotId },
      });
    }

    case "turn/resumed": {
      const turn = state.turn;
      if (!turn || turn.id !== event.turnId) {
        return rejected(state, "stale_turn");
      }
      if (
        event.tentativeEotId !== undefined &&
        event.tentativeEotId !== turn.tentativeEotId
      ) {
        return rejected(state, "stale_turn");
      }
      const transition = resumeTurn(state, event.atMs);
      if (!transition.accepted) return transition;
      const attempt = state.speechAttempt;
      return accepted(transition.state, [
        ...(attempt
          ? [
              {
                type: "timer/cancel" as const,
                key: timerKey("speech", attempt.id),
              },
            ]
          : []),
        ...transition.effects,
      ]);
    }

    case "turn/commit": {
      const turn = state.turn;
      if (!turn || turn.id !== event.turnId) {
        return rejected(state, "stale_turn");
      }
      if (turn.stage !== "transcribing" && turn.stage !== "eot_tentative") {
        return rejected(state, "invalid_state");
      }
      if (event.transcriptRevision !== turn.transcriptRevision) {
        return rejected(state, "stale_transcript_revision");
      }
      const mergeDeadlineMs = event.atMs + state.policy.eotMergeWindowMs;
      const committedTurn: CoordinatedTurn = {
        ...turn,
        stage: "semantic",
        disposition: event.disposition,
        tentativeEotId: null,
        committedAtMs: event.atMs,
        mergeDeadlineMs,
      };
      const commitEffect: TurnCoordinatorEffect = {
        type: "turn/commit_revision",
        turnId: turn.id,
        revision: turn.revision,
        supersedesRevision: turn.supersedesRevision,
        disposition: event.disposition,
      };

      if (event.disposition !== "respond") {
        const outcome =
          event.disposition === "control_stop" ? "stopped" : "no_response";
        return accepted(
          {
            ...state,
            lastAtMs: event.atMs,
            turn: committedTurn,
            pendingRepair: null,
            interruption: null,
          },
          [
            commitEffect,
            {
              type: "turn/end",
              turnId: turn.id,
              revision: turn.revision,
              outcome,
            },
          ],
        );
      }

      if (state.response) return rejected(state, "response_active");
      const created = createResponse(
        { ...state, turn: committedTurn },
        committedTurn,
      );
      const effects: TurnCoordinatorEffect[] = [commitEffect];
      if (state.pendingRepair) {
        effects.push({
          type: "repair/queue",
          turnId: turn.id,
          interruptedResponseId: state.pendingRepair.interruptedResponseId,
          speakAfterNextEot: true,
        });
      }
      effects.push(
        {
          type: "response/start",
          responseId: created.response.id,
          turnId: turn.id,
          turnRevision: turn.revision,
        },
        {
          type: "timer/arm",
          key: timerKey("merge", `${turn.id}:${turn.revision}`),
          deadlineMs: mergeDeadlineMs,
        },
      );
      return accepted(
        {
          ...created.state,
          lastAtMs: event.atMs,
          pendingRepair: null,
        },
        effects,
      );
    }

    case "timer/merge_elapsed": {
      const turn = state.turn;
      if (
        !turn ||
        turn.id !== event.turnId ||
        turn.revision !== event.turnRevision
      ) {
        return rejected(state, "stale_turn");
      }
      if (turn.stage !== "semantic" || turn.mergeDeadlineMs === null) {
        return rejected(state, "invalid_state");
      }
      if (event.atMs < turn.mergeDeadlineMs) {
        return rejected(state, "timer_not_due");
      }
      const tasks: Record<string, Readonly<CoordinatedTask>> = {
        ...state.tasks,
      };
      const effects: TurnCoordinatorEffect[] = [
        {
          type: "timer/cancel",
          key: timerKey("merge", `${turn.id}:${turn.revision}`),
        },
      ];
      for (const task of Object.values(state.tasks)) {
        if (
          task.turnId === turn.id &&
          task.turnRevision === turn.revision &&
          task.status === "deferred" &&
          state.response?.id === task.responseId
        ) {
          tasks[task.id] = { ...task, status: "running" };
          effects.push({ type: "task/start", taskId: task.id });
        }
      }
      return accepted(
        {
          ...state,
          lastAtMs: event.atMs,
          turn: { ...turn, stage: "sealed" },
          tasks,
        },
        effects,
      );
    }

    case "response/model_started":
    case "response/speaking_started": {
      const response = state.response;
      if (!response || response.id !== event.responseId) {
        return rejected(state, "stale_response");
      }
      const status =
        event.type === "response/model_started" ? "thinking" : "speaking";
      let turn = state.turn;
      if (status === "speaking" && turn?.lastResponse?.id === response.id) {
        turn = {
          ...turn,
          lastResponse: { ...turn.lastResponse, audibleStarted: true },
        };
      }
      return accepted({
        ...state,
        lastAtMs: event.atMs,
        response: { ...response, status },
        turn,
      });
    }

    case "playback/enqueued":
    case "playback/drained": {
      const turn = state.turn;
      const lastResponse = turn?.lastResponse;
      if (!turn || !lastResponse || lastResponse.id !== event.responseId) {
        return rejected(state, "stale_response");
      }
      if (
        event.type === "playback/enqueued" &&
        state.response?.id !== event.responseId
      ) {
        // Revoked/settled responses may drain retained browser audio, but they
        // can never acquire new playout ownership.
        return rejected(state, "stale_response");
      }
      return accepted({
        ...state,
        lastAtMs: event.atMs,
        turn: {
          ...turn,
          lastResponse: {
            ...lastResponse,
            playoutPending: event.type === "playback/enqueued",
          },
        },
      });
    }

    case "response/settled": {
      const response = state.response;
      if (!response || response.id !== event.responseId) {
        return rejected(state, "stale_response");
      }
      let turn = state.turn;
      if (turn?.lastResponse?.id === response.id) {
        turn = {
          ...turn,
          lastResponse: { ...turn.lastResponse, settled: true },
        };
      }
      const settled = settleTasksForResponse(state, response.id);
      return accepted(
        {
          ...state,
          lastAtMs: event.atMs,
          response: null,
          turn,
          tasks: settled.tasks,
          interruption: null,
        },
        settled.effects,
      );
    }

    case "response/retry": {
      const turn = state.turn;
      if (
        !turn ||
        turn.id !== event.turnId ||
        turn.revision !== event.turnRevision
      ) {
        return rejected(state, "stale_turn");
      }
      if (state.lifecycle !== "listening") {
        return rejected(state, "invalid_state");
      }
      if (state.response) return rejected(state, "response_active");
      if (
        (turn.stage !== "semantic" && turn.stage !== "sealed") ||
        turn.disposition !== "respond"
      ) {
        return rejected(state, "turn_does_not_respond");
      }
      const created = createResponse(state, turn);
      return accepted({ ...created.state, lastAtMs: event.atMs }, [
        {
          type: "response/start",
          responseId: created.response.id,
          turnId: turn.id,
          turnRevision: turn.revision,
        },
      ]);
    }

    case "task/requested": {
      const response = state.response;
      const turn = state.turn;
      if (!response || response.id !== event.responseId) {
        return rejected(state, "stale_response");
      }
      if (
        !turn ||
        turn.id !== response.turnId ||
        turn.revision !== response.turnRevision
      ) {
        return rejected(state, "stale_turn");
      }
      const idempotencyKey = event.idempotencyKey?.trim() || null;
      if (event.effect === "mutating" && !idempotencyKey) {
        return rejected(state, "mutation_requires_idempotency_key");
      }
      const sequence = state.counters.task + 1;
      const id = makeId<TaskId>(state.sessionId, "task", sequence);
      const status =
        event.effect === "mutating" && turn.stage !== "sealed"
          ? "deferred"
          : "running";
      const task: CoordinatedTask = {
        id,
        turnId: turn.id,
        turnRevision: turn.revision,
        responseId: response.id,
        lifetime: event.lifetime,
        effect: event.effect,
        restartable: event.restartable,
        idempotencyKey,
        status,
      };
      return accepted(
        {
          ...state,
          lastAtMs: event.atMs,
          counters: { ...state.counters, task: sequence },
          tasks: { ...state.tasks, [id]: task },
        },
        status === "running" ? [{ type: "task/start", taskId: id }] : [],
      );
    }

    case "task/commit_crossed": {
      const task = state.tasks[event.taskId];
      if (!task) return rejected(state, "stale_task");
      if (task.effect !== "mutating") {
        return rejected(state, "task_not_mutating");
      }
      if (!isTaskCommitAuthorized(state, task.id)) {
        return rejected(state, "mutation_not_sealed");
      }
      return accepted({
        ...state,
        lastAtMs: event.atMs,
        tasks: {
          ...state.tasks,
          [task.id]: { ...task, status: "commit_crossed" },
        },
      });
    }

    case "task/settled": {
      const task = state.tasks[event.taskId];
      if (!task) return rejected(state, "stale_task");
      const tasks = { ...state.tasks };
      delete tasks[task.id];
      return accepted({ ...state, lastAtMs: event.atMs, tasks }, [
        {
          type: "task/result_available",
          taskId: task.id,
          responseId: task.responseId,
          delivery: isTaskSpeechAuthorized(state, task.id)
            ? "response_router"
            : "background_visual",
        },
      ]);
    }

    case "interrupt/explicit": {
      const reason: TurnInterruptionReason = "explicit";
      const pendingPlayoutId = pendingPlayoutResponseId(state);
      const revoked = revokeResponse(state, reason, event.atMs);
      const effects: TurnCoordinatorEffect[] = [];
      if (state.speechAttempt) {
        effects.push({
          type: "timer/cancel",
          key: timerKey("speech", state.speechAttempt.id),
        });
        if (!revoked.responseId) {
          effects.push({
            type: "playback/flush",
            responseId: state.speechAttempt.pausedResponseId,
          });
        }
      }
      if (!revoked.responseId && pendingPlayoutId && !state.speechAttempt) {
        effects.push(
          { type: "playback/flush", responseId: pendingPlayoutId },
          { type: "output/retract", responseId: pendingPlayoutId },
        );
      }
      effects.push(...revoked.effects);
      return accepted(
        {
          ...clearPendingPlayout(revoked.state, pendingPlayoutId),
          lastAtMs: event.atMs,
          speechAttempt: null,
          pendingRepair: null,
        },
        effects,
      );
    }

    case "session/listening": {
      if (
        state.lifecycle !== "degraded" &&
        state.lifecycle !== "reconnecting"
      ) {
        return rejected(state, "invalid_state");
      }
      return accepted({
        ...state,
        lifecycle: "listening",
        lastAtMs: event.atMs,
        interruption: null,
      });
    }

    case "session/degraded":
    case "session/reconnecting":
    case "session/closed": {
      const lifecycle: TurnCoordinatorLifecycle =
        event.type === "session/degraded"
          ? "degraded"
          : event.type === "session/reconnecting"
            ? "reconnecting"
            : "closed";
      const reason: TurnInterruptionReason =
        lifecycle === "degraded"
          ? "degraded"
          : lifecycle === "reconnecting"
            ? "reconnect"
            : "session_closed";
      const pendingPlayoutId = pendingPlayoutResponseId(state);
      const revoked = revokeResponse(state, reason, event.atMs);
      const effects: TurnCoordinatorEffect[] = [];
      if (state.speechAttempt) {
        effects.push({
          type: "timer/cancel",
          key: timerKey("speech", state.speechAttempt.id),
        });
        if (!revoked.responseId) {
          effects.push({
            type: "playback/flush",
            responseId: state.speechAttempt.pausedResponseId,
          });
        }
      }
      if (!revoked.responseId && pendingPlayoutId && !state.speechAttempt) {
        effects.push(
          { type: "playback/flush", responseId: pendingPlayoutId },
          { type: "output/retract", responseId: pendingPlayoutId },
        );
      }
      effects.push(...revoked.effects);
      const cleared = clearPendingPlayout(revoked.state, pendingPlayoutId);
      const turn =
        cleared.turn?.stage === "transcribing" ||
        cleared.turn?.stage === "eot_tentative"
          ? null
          : cleared.turn;
      return accepted(
        {
          ...cleared,
          lifecycle,
          lastAtMs: event.atMs,
          speechAttempt: null,
          turn,
          pendingRepair: null,
        },
        effects,
      );
    }
  }
}
