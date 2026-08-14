import { describe, expect, it } from "vitest";
import {
  type CoordinatedTask,
  createTurnCoordinatorState,
  isCurrentResponse,
  isTaskCommitAuthorized,
  isTaskSpeechAuthorized,
  projectTurnPhase,
  type ResponseId,
  reduceTurnCoordinator,
  type SpeechAttemptId,
  type TurnCoordinatorState,
  type TurnCoordinatorTransition,
  type TurnId,
} from "./turn-coordinator";

const SESSION_ID = "session-test";

function initial(): TurnCoordinatorState {
  return createTurnCoordinatorState({ sessionId: SESSION_ID, atMs: 0 });
}

function confirmSpeech(
  state: TurnCoordinatorState,
  atMs: number,
  continuation: "auto" | "new_turn" = "new_turn",
): TurnCoordinatorTransition {
  return reduceTurnCoordinator(state, {
    type: "speech/confirmed",
    sessionId: SESSION_ID,
    atMs,
    continuation,
  });
}

function revise(
  state: TurnCoordinatorState,
  atMs: number,
  transcriptRevision: number,
): TurnCoordinatorState {
  const turnId = state.turn?.id as TurnId;
  const transition = reduceTurnCoordinator(state, {
    type: "transcript/revised",
    sessionId: SESSION_ID,
    atMs,
    turnId,
    transcriptRevision,
  });
  expect(transition.accepted).toBe(true);
  return transition.state;
}

function commitResponse(
  state: TurnCoordinatorState,
  atMs: number,
): TurnCoordinatorState {
  const turn = state.turn;
  const transition = reduceTurnCoordinator(state, {
    type: "turn/commit",
    sessionId: SESSION_ID,
    atMs,
    turnId: turn?.id as TurnId,
    transcriptRevision: turn?.transcriptRevision as number,
    disposition: "respond",
  });
  expect(transition.accepted).toBe(true);
  return transition.state;
}

function responseState(input: { speaking?: boolean; settle?: boolean } = {}): {
  state: TurnCoordinatorState;
  turnId: TurnId;
  responseId: ResponseId;
} {
  let state = confirmSpeech(initial(), 1).state;
  state = revise(state, 2, 1);
  state = commitResponse(state, 3);
  const turnId = state.turn?.id as TurnId;
  const responseId = state.response?.id as ResponseId;
  if (input.speaking) {
    state = reduceTurnCoordinator(state, {
      type: "response/speaking_started",
      sessionId: SESSION_ID,
      atMs: 4,
      responseId,
    }).state;
  }
  if (input.speaking && input.settle) {
    state = reduceTurnCoordinator(state, {
      type: "playback/enqueued",
      sessionId: SESSION_ID,
      atMs: 5,
      responseId,
    }).state;
  }
  if (input.settle) {
    state = reduceTurnCoordinator(state, {
      type: "response/settled",
      sessionId: SESSION_ID,
      atMs: input.speaking ? 6 : 5,
      responseId,
      outcome: input.speaking ? "spoken" : "no_response",
    }).state;
  }
  return { state, turnId, responseId };
}

function requestTask(
  state: TurnCoordinatorState,
  atMs: number,
  input: {
    lifetime?: "response" | "durable";
    effect?: "read_only" | "mutating";
    restartable?: boolean;
    idempotencyKey?: string;
  } = {},
): { state: TurnCoordinatorState; task: CoordinatedTask } {
  const transition = reduceTurnCoordinator(state, {
    type: "task/requested",
    sessionId: SESSION_ID,
    atMs,
    responseId: state.response?.id as ResponseId,
    lifetime: input.lifetime ?? "response",
    effect: input.effect ?? "read_only",
    restartable: input.restartable ?? true,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  });
  expect(transition.accepted).toBe(true);
  const task = Object.values(transition.state.tasks).find(
    (candidate) => state.tasks[candidate.id] === undefined,
  ) as CoordinatedTask;
  return { state: transition.state, task };
}

describe("TurnCoordinator provisional speech", () => {
  it("pauses locally without revoking response authority", () => {
    const setup = responseState({ speaking: true });
    const transition = reduceTurnCoordinator(setup.state, {
      type: "speech/provisional_started",
      sessionId: SESSION_ID,
      atMs: 10,
    });

    expect(transition.accepted).toBe(true);
    expect(transition.state.response?.id).toBe(setup.responseId);
    expect(isCurrentResponse(transition.state, setup.responseId)).toBe(true);
    expect(projectTurnPhase(transition.state)).toBe("speech_tentative");
    expect(transition.effects).toEqual([
      { type: "playback/pause", responseId: setup.responseId },
      {
        type: "timer/arm",
        key: expect.stringContaining("speech-attempt"),
        deadlineMs: 360,
      },
    ]);
    expect(
      transition.effects.some(
        (effect) =>
          effect.type === "model/abort" || effect.type === "tts/cancel",
      ),
    ).toBe(false);
  });

  it("resumes the exact retained buffer after an unconfirmed timeout", () => {
    const setup = responseState({ speaking: true });
    const paused = reduceTurnCoordinator(setup.state, {
      type: "speech/provisional_started",
      sessionId: SESSION_ID,
      atMs: 10,
    });
    const attempt = paused.state.speechAttempt;
    const early = reduceTurnCoordinator(paused.state, {
      type: "timer/speech_confirmation_elapsed",
      sessionId: SESSION_ID,
      atMs: 359,
      speechAttemptId: attempt?.id as never,
    });
    expect(early.rejection).toBe("timer_not_due");

    const elapsed = reduceTurnCoordinator(paused.state, {
      type: "timer/speech_confirmation_elapsed",
      sessionId: SESSION_ID,
      atMs: 360,
      speechAttemptId: attempt?.id as never,
    });
    expect(elapsed.state.speechAttempt).toBeNull();
    expect(elapsed.effects).toEqual([
      { type: "timer/cancel", key: expect.stringContaining("speech-attempt") },
      { type: "playback/resume", responseId: setup.responseId },
    ]);
  });

  it("makes a stale timeout harmless after authoritative confirmation", () => {
    const setup = responseState({ speaking: true });
    const paused = reduceTurnCoordinator(setup.state, {
      type: "speech/provisional_started",
      sessionId: SESSION_ID,
      atMs: 10,
    });
    const attemptId = paused.state.speechAttempt?.id as never;
    const confirmed = reduceTurnCoordinator(paused.state, {
      type: "speech/confirmed",
      sessionId: SESSION_ID,
      atMs: 20,
      speechAttemptId: attemptId,
      continuation: "new_turn",
    });
    expect(isCurrentResponse(confirmed.state, setup.responseId)).toBe(false);

    const stale = reduceTurnCoordinator(confirmed.state, {
      type: "timer/speech_confirmation_elapsed",
      sessionId: SESSION_ID,
      atMs: 360,
      speechAttemptId: attemptId,
    });
    expect(stale.accepted).toBe(false);
    expect(stale.rejection).toBe("stale_speech_attempt");
    expect(stale.state).toBe(confirmed.state);
    expect(stale.effects).toEqual([]);
  });

  it("rejects a stale confirmation for an older speech attempt", () => {
    const setup = responseState({ speaking: true });
    const first = reduceTurnCoordinator(setup.state, {
      type: "speech/provisional_started",
      sessionId: SESSION_ID,
      atMs: 10,
    });
    const firstAttemptId = first.state.speechAttempt?.id as SpeechAttemptId;
    const rejected = reduceTurnCoordinator(first.state, {
      type: "speech/provisional_rejected",
      sessionId: SESSION_ID,
      atMs: 11,
      speechAttemptId: firstAttemptId,
    });
    const second = reduceTurnCoordinator(rejected.state, {
      type: "speech/provisional_started",
      sessionId: SESSION_ID,
      atMs: 12,
    });
    const secondAttemptId = second.state.speechAttempt?.id;

    const stale = reduceTurnCoordinator(second.state, {
      type: "speech/confirmed",
      sessionId: SESSION_ID,
      atMs: 13,
      speechAttemptId: firstAttemptId,
      continuation: "new_turn",
    });

    expect(stale.rejection).toBe("stale_speech_attempt");
    expect(stale.state).toBe(second.state);
    expect(stale.state.speechAttempt?.id).toBe(secondAttemptId);
    expect(stale.state.response?.id).toBe(setup.responseId);
    expect(stale.effects).toEqual([]);
  });

  it("normalizes an older timestamp for the exact current confirmation", () => {
    const setup = responseState({ speaking: true });
    const paused = reduceTurnCoordinator(setup.state, {
      type: "speech/provisional_started",
      sessionId: SESSION_ID,
      atMs: 10,
    });
    const attemptId = paused.state.speechAttempt?.id as SpeechAttemptId;

    const confirmed = reduceTurnCoordinator(paused.state, {
      type: "speech/confirmed",
      sessionId: SESSION_ID,
      atMs: 1,
      speechAttemptId: attemptId,
      continuation: "new_turn",
    });

    expect(confirmed.accepted).toBe(true);
    expect(confirmed.state.lastAtMs).toBe(10);
    expect(confirmed.state.speechAttempt).toBeNull();
    expect(confirmed.state.response).toBeNull();
    expect(confirmed.effects).toEqual(
      expect.arrayContaining([
        { type: "timer/cancel", key: expect.stringContaining(attemptId) },
        { type: "playback/flush", responseId: setup.responseId },
      ]),
    );
  });
});

describe("TurnCoordinator response authority and EOT repair", () => {
  it("revokes the exact response before emitting cancellation effects", () => {
    const setup = responseState({ speaking: true });
    const transition = confirmSpeech(setup.state, 20, "new_turn");

    expect(transition.state.response).toBeNull();
    expect(isCurrentResponse(transition.state, setup.responseId)).toBe(false);
    expect(transition.state.turn?.id).not.toBe(setup.turnId);
    expect(transition.effects.slice(0, 5)).toEqual([
      { type: "playback/flush", responseId: setup.responseId },
      {
        type: "tts/cancel",
        responseId: setup.responseId,
        reason: "confirmed_speech",
      },
      {
        type: "model/abort",
        responseId: setup.responseId,
        reason: "confirmed_speech",
      },
      { type: "output/retract", responseId: setup.responseId },
      {
        type: "progress/cancel",
        responseId: setup.responseId,
        reason: "confirmed_speech",
      },
    ]);

    const late = reduceTurnCoordinator(transition.state, {
      type: "response/speaking_started",
      sessionId: SESSION_ID,
      atMs: 21,
      responseId: setup.responseId,
    });
    expect(late.rejection).toBe("stale_response");
    expect(late.state).toBe(transition.state);
  });

  it("revokes tentative EOT without persistence or response work", () => {
    let state = confirmSpeech(initial(), 1).state;
    const turnId = state.turn?.id as TurnId;
    state = revise(state, 2, 1);
    const tentative = reduceTurnCoordinator(state, {
      type: "eot/tentative",
      sessionId: SESSION_ID,
      atMs: 3,
      turnId,
      transcriptRevision: 1,
    });
    const eotId = tentative.state.turn?.tentativeEotId;
    expect(tentative.effects).toEqual([]);
    expect(projectTurnPhase(tentative.state)).toBe("eot_tentative");

    const resumed = reduceTurnCoordinator(tentative.state, {
      type: "turn/resumed",
      sessionId: SESSION_ID,
      atMs: 4,
      turnId,
      tentativeEotId: eotId as never,
    });
    expect(resumed.state.turn).toMatchObject({
      id: turnId,
      revision: 1,
      stage: "transcribing",
      tentativeEotId: null,
    });
    expect(resumed.effects).toEqual([]);
    expect(resumed.state.counters.response).toBe(0);
  });

  it("rejects a resume event when no EOT boundary is open", () => {
    const capturing = confirmSpeech(initial(), 1).state;
    const transition = reduceTurnCoordinator(capturing, {
      type: "turn/resumed",
      sessionId: SESSION_ID,
      atMs: 2,
      turnId: capturing.turn?.id as TurnId,
    });
    expect(transition.rejection).toBe("invalid_state");
    expect(transition.state).toBe(capturing);
  });

  it("merges a committed audible false cutoff and queues one repair on recommit", () => {
    const setup = responseState({ speaking: true });
    const resumed = confirmSpeech(setup.state, 100, "auto");
    expect(resumed.state.turn).toMatchObject({
      id: setup.turnId,
      revision: 1,
      stage: "transcribing",
      supersedesRevision: 0,
    });
    expect(resumed.state.pendingRepair).toEqual({
      turnId: setup.turnId,
      interruptedResponseId: setup.responseId,
      audibleCutoff: true,
    });

    const state = revise(resumed.state, 101, 2);
    const recommit = reduceTurnCoordinator(state, {
      type: "turn/commit",
      sessionId: SESSION_ID,
      atMs: 102,
      turnId: setup.turnId,
      transcriptRevision: 2,
      disposition: "respond",
    });
    const replacementId = recommit.state.response?.id;
    expect(replacementId).not.toBe(setup.responseId);
    expect(recommit.effects).toEqual([
      {
        type: "turn/commit_revision",
        turnId: setup.turnId,
        revision: 1,
        supersedesRevision: 0,
        disposition: "respond",
      },
      {
        type: "repair/queue",
        turnId: setup.turnId,
        interruptedResponseId: setup.responseId,
        speakAfterNextEot: true,
      },
      {
        type: "response/start",
        responseId: replacementId,
        turnId: setup.turnId,
        turnRevision: 1,
      },
      {
        type: "timer/arm",
        key: expect.stringContaining(`${setup.turnId}:1`),
        deadlineMs: 1_002,
      },
    ]);
    expect(recommit.state.pendingRepair).toBeNull();
  });

  it("does not apologize when the invalidated answer was never audible", () => {
    const setup = responseState();
    const resumed = confirmSpeech(setup.state, 100, "auto");
    expect(resumed.state.pendingRepair).toBeNull();
    const state = revise(resumed.state, 101, 2);
    const recommit = reduceTurnCoordinator(state, {
      type: "turn/commit",
      sessionId: SESSION_ID,
      atMs: 102,
      turnId: setup.turnId,
      transcriptRevision: 2,
      disposition: "respond",
    });
    expect(
      recommit.effects.some((effect) => effect.type === "repair/queue"),
    ).toBe(false);
  });

  it("accepts the merge deadline exactly and rejects a later explicit resume", () => {
    const exactSetup = responseState();
    const deadline = exactSetup.state.turn?.mergeDeadlineMs as number;
    const exact = reduceTurnCoordinator(exactSetup.state, {
      type: "turn/resumed",
      sessionId: SESSION_ID,
      atMs: deadline,
      turnId: exactSetup.turnId,
    });
    expect(exact.accepted).toBe(true);
    expect(exact.state.turn?.id).toBe(exactSetup.turnId);

    const lateSetup = responseState();
    const late = reduceTurnCoordinator(lateSetup.state, {
      type: "turn/resumed",
      sessionId: SESSION_ID,
      atMs: (lateSetup.state.turn?.mergeDeadlineMs as number) + 1,
      turnId: lateSetup.turnId,
    });
    expect(late.rejection).toBe("merge_window_elapsed");
    expect(late.state).toBe(lateSetup.state);

    const normalizedNew = confirmSpeech(
      lateSetup.state,
      (lateSetup.state.turn?.mergeDeadlineMs as number) + 1,
      "auto",
    );
    expect(normalizedNew.accepted).toBe(true);
    expect(normalizedNew.state.turn?.id).not.toBe(lateSetup.turnId);
  });

  it("retains audible ownership after response settlement for tail repair", () => {
    const setup = responseState({ speaking: true, settle: true });
    expect(setup.state.response).toBeNull();
    expect(setup.state.turn?.lastResponse).toMatchObject({
      id: setup.responseId,
      audibleStarted: true,
      playoutPending: true,
      settled: true,
    });

    const paused = reduceTurnCoordinator(setup.state, {
      type: "speech/provisional_started",
      sessionId: SESSION_ID,
      atMs: 10,
    });
    expect(paused.effects[0]).toEqual({
      type: "playback/pause",
      responseId: setup.responseId,
    });
    const repaired = confirmSpeech(paused.state, 20, "auto");
    expect(repaired.state.pendingRepair?.interruptedResponseId).toBe(
      setup.responseId,
    );
    expect(repaired.effects).toEqual(
      expect.arrayContaining([
        { type: "playback/flush", responseId: setup.responseId },
        { type: "output/retract", responseId: setup.responseId },
      ]),
    );
  });

  it("does not cut off or repair a settled response after playout drains", () => {
    const setup = responseState({ speaking: true, settle: true });
    const drained = reduceTurnCoordinator(setup.state, {
      type: "playback/drained",
      sessionId: SESSION_ID,
      atMs: 7,
      responseId: setup.responseId,
    });
    expect(drained.accepted).toBe(true);
    expect(drained.state.turn?.lastResponse?.playoutPending).toBe(false);

    const provisional = reduceTurnCoordinator(drained.state, {
      type: "speech/provisional_started",
      sessionId: SESSION_ID,
      atMs: 8,
    });
    expect(provisional.rejection).toBe("no_interruptible_response");
    expect(provisional.effects).toEqual([]);

    const continued = confirmSpeech(drained.state, 9, "auto");
    expect(continued.accepted).toBe(true);
    expect(continued.state.pendingRepair).toBeNull();
    expect(continued.effects).toEqual([]);
    expect(continued.state.turn).toMatchObject({
      id: setup.turnId,
      revision: 1,
      stage: "transcribing",
    });
  });

  it("accepts exact response settlement despite an older observed timestamp", () => {
    const setup = responseState({ speaking: true });
    const enqueued = reduceTurnCoordinator(setup.state, {
      type: "playback/enqueued",
      sessionId: SESSION_ID,
      atMs: 5,
      responseId: setup.responseId,
    });
    const settled = reduceTurnCoordinator(enqueued.state, {
      type: "response/settled",
      sessionId: SESSION_ID,
      atMs: 2,
      responseId: setup.responseId,
      outcome: "spoken",
    });

    expect(settled.accepted).toBe(true);
    expect(settled.state.lastAtMs).toBe(5);
    expect(settled.state.response).toBeNull();
    expect(settled.state.turn?.lastResponse).toMatchObject({
      id: setup.responseId,
      settled: true,
      playoutPending: true,
    });
  });

  it("treats spoken stop as control instead of allocating a response", () => {
    let state = confirmSpeech(initial(), 1).state;
    state = revise(state, 2, 1);
    const turn = state.turn;
    const stopped = reduceTurnCoordinator(state, {
      type: "turn/commit",
      sessionId: SESSION_ID,
      atMs: 3,
      turnId: turn?.id as TurnId,
      transcriptRevision: 1,
      disposition: "control_stop",
    });
    expect(stopped.state.response).toBeNull();
    expect(stopped.state.counters.response).toBe(0);
    expect(stopped.effects).toEqual([
      expect.objectContaining({ type: "turn/commit_revision" }),
      {
        type: "turn/end",
        turnId: turn?.id,
        revision: 0,
        outcome: "stopped",
      },
    ]);
  });
});

describe("TurnCoordinator task domains", () => {
  it("requires idempotency and defers mutation until the exact turn seals", () => {
    const setup = responseState();
    const missing = reduceTurnCoordinator(setup.state, {
      type: "task/requested",
      sessionId: SESSION_ID,
      atMs: 4,
      responseId: setup.responseId,
      lifetime: "response",
      effect: "mutating",
      restartable: true,
    });
    expect(missing.rejection).toBe("mutation_requires_idempotency_key");

    const requested = requestTask(setup.state, 4, {
      effect: "mutating",
      idempotencyKey: "turn-mutation-1",
    });
    expect(requested.task.status).toBe("deferred");
    expect(isTaskCommitAuthorized(requested.state, requested.task.id)).toBe(
      false,
    );
    const premature = reduceTurnCoordinator(requested.state, {
      type: "task/commit_crossed",
      sessionId: SESSION_ID,
      atMs: 5,
      taskId: requested.task.id,
    });
    expect(premature.rejection).toBe("mutation_not_sealed");

    const deadline = requested.state.turn?.mergeDeadlineMs as number;
    const sealed = reduceTurnCoordinator(requested.state, {
      type: "timer/merge_elapsed",
      sessionId: SESSION_ID,
      atMs: deadline,
      turnId: setup.turnId,
      turnRevision: 0,
    });
    expect(sealed.state.turn?.stage).toBe("sealed");
    expect(sealed.state.tasks[requested.task.id]?.status).toBe("running");
    expect(sealed.effects).toContainEqual({
      type: "task/start",
      taskId: requested.task.id,
    });
    expect(isTaskCommitAuthorized(sealed.state, requested.task.id)).toBe(true);

    const crossed = reduceTurnCoordinator(sealed.state, {
      type: "task/commit_crossed",
      sessionId: SESSION_ID,
      atMs: deadline + 1,
      taskId: requested.task.id,
    });
    expect(crossed.accepted).toBe(true);
    expect(crossed.state.tasks[requested.task.id]?.status).toBe(
      "commit_crossed",
    );
  });

  it("applies abort, detach, actual-state, and durable policies by task", () => {
    const setup = responseState({ speaking: true });
    const deadline = setup.state.turn?.mergeDeadlineMs as number;
    let state = reduceTurnCoordinator(setup.state, {
      type: "timer/merge_elapsed",
      sessionId: SESSION_ID,
      atMs: deadline,
      turnId: setup.turnId,
      turnRevision: 0,
    }).state;

    const restartable = requestTask(state, deadline + 1, {
      effect: "read_only",
      restartable: true,
    });
    state = restartable.state;
    const nonrestartable = requestTask(state, deadline + 2, {
      effect: "read_only",
      restartable: false,
    });
    state = nonrestartable.state;
    const uncommittedMutation = requestTask(state, deadline + 3, {
      effect: "mutating",
      idempotencyKey: "mutation-a",
    });
    state = uncommittedMutation.state;
    const committedMutation = requestTask(state, deadline + 4, {
      effect: "mutating",
      idempotencyKey: "mutation-b",
    });
    state = reduceTurnCoordinator(committedMutation.state, {
      type: "task/commit_crossed",
      sessionId: SESSION_ID,
      atMs: deadline + 5,
      taskId: committedMutation.task.id,
    }).state;
    const durable = requestTask(state, deadline + 6, {
      lifetime: "durable",
      effect: "read_only",
      restartable: true,
    });
    state = durable.state;

    const interrupted = confirmSpeech(state, deadline + 7, "new_turn");
    expect(interrupted.effects).toEqual(
      expect.arrayContaining([
        { type: "task/abort", taskId: restartable.task.id },
        { type: "task/detach", taskId: nonrestartable.task.id },
        { type: "task/abort", taskId: uncommittedMutation.task.id },
        { type: "task/detach", taskId: committedMutation.task.id },
        {
          type: "task/report_actual_state",
          taskId: committedMutation.task.id,
        },
        { type: "task/detach", taskId: durable.task.id },
      ]),
    );
    expect(interrupted.state.tasks[restartable.task.id]).toBeUndefined();
    expect(
      interrupted.state.tasks[uncommittedMutation.task.id],
    ).toBeUndefined();
    expect(interrupted.state.tasks[nonrestartable.task.id]?.status).toBe(
      "detached",
    );
    expect(interrupted.state.tasks[committedMutation.task.id]?.status).toBe(
      "detached",
    );
    expect(interrupted.state.tasks[durable.task.id]?.status).toBe("detached");
    expect(isTaskSpeechAuthorized(interrupted.state, durable.task.id)).toBe(
      false,
    );
  });

  it("routes detached completion visually and current completion through the router", () => {
    const setup = responseState();
    const current = requestTask(setup.state, 4);
    const currentResult = reduceTurnCoordinator(current.state, {
      type: "task/settled",
      sessionId: SESSION_ID,
      atMs: 5,
      taskId: current.task.id,
    });
    expect(currentResult.effects).toEqual([
      {
        type: "task/result_available",
        taskId: current.task.id,
        responseId: setup.responseId,
        delivery: "response_router",
      },
    ]);

    const durable = requestTask(setup.state, 4, { lifetime: "durable" });
    const interrupted = confirmSpeech(durable.state, 5, "new_turn");
    const detachedResult = reduceTurnCoordinator(interrupted.state, {
      type: "task/settled",
      sessionId: SESSION_ID,
      atMs: 6,
      taskId: durable.task.id,
    });
    expect(detachedResult.effects).toEqual([
      {
        type: "task/result_available",
        taskId: durable.task.id,
        responseId: setup.responseId,
        delivery: "background_visual",
      },
    ]);
  });

  it("drops deferred durable mutation and aborts running response work on settlement", () => {
    const setup = responseState();
    const deferredDurable = requestTask(setup.state, 4, {
      lifetime: "durable",
      effect: "mutating",
      idempotencyKey: "durable-mutation",
    });
    const interrupted = confirmSpeech(deferredDurable.state, 5, "new_turn");
    expect(interrupted.state.tasks[deferredDurable.task.id]).toBeUndefined();
    expect(
      interrupted.effects.some(
        (effect) =>
          (effect.type === "task/abort" || effect.type === "task/detach") &&
          effect.taskId === deferredDurable.task.id,
      ),
    ).toBe(false);

    const running = requestTask(setup.state, 4, {
      lifetime: "response",
      effect: "read_only",
      restartable: true,
    });
    const settled = reduceTurnCoordinator(running.state, {
      type: "response/settled",
      sessionId: SESSION_ID,
      atMs: 5,
      responseId: setup.responseId,
      outcome: "no_response",
    });
    expect(settled.state.tasks[running.task.id]).toBeUndefined();
    expect(settled.effects).toContainEqual({
      type: "task/abort",
      taskId: running.task.id,
    });
  });
});

describe("TurnCoordinator retry and session guards", () => {
  it("cancels an explicit stop while thinking without opening another turn", () => {
    const setup = responseState();
    const thinking = reduceTurnCoordinator(setup.state, {
      type: "response/model_started",
      sessionId: SESSION_ID,
      atMs: 4,
      responseId: setup.responseId,
    }).state;
    const stopped = reduceTurnCoordinator(thinking, {
      type: "interrupt/explicit",
      sessionId: SESSION_ID,
      atMs: 5,
      reason: "user_stop",
    });
    expect(stopped.state.response).toBeNull();
    expect(stopped.state.turn?.id).toBe(setup.turnId);
    expect(projectTurnPhase(stopped.state)).toBe("interrupting");
    expect(stopped.effects).toEqual(
      expect.arrayContaining([
        {
          type: "model/abort",
          responseId: setup.responseId,
          reason: "explicit",
        },
        {
          type: "tts/cancel",
          responseId: setup.responseId,
          reason: "explicit",
        },
      ]),
    );
  });

  it("reconnects without stale audio and retries under a fresh response ID", () => {
    const setup = responseState({ speaking: true });
    const reconnecting = reduceTurnCoordinator(setup.state, {
      type: "session/reconnecting",
      sessionId: SESSION_ID,
      atMs: 10,
    });
    expect(reconnecting.state.lifecycle).toBe("reconnecting");
    expect(reconnecting.state.response).toBeNull();
    expect(reconnecting.state.turn?.id).toBe(setup.turnId);
    expect(reconnecting.effects).toContainEqual({
      type: "playback/flush",
      responseId: setup.responseId,
    });

    const listening = reduceTurnCoordinator(reconnecting.state, {
      type: "session/listening",
      sessionId: SESSION_ID,
      atMs: 11,
    });
    const retried = reduceTurnCoordinator(listening.state, {
      type: "response/retry",
      sessionId: SESSION_ID,
      atMs: 12,
      turnId: setup.turnId,
      turnRevision: 0,
    });
    const retryId = retried.state.response?.id as ResponseId;
    expect(retryId).not.toBe(setup.responseId);
    expect(isCurrentResponse(retried.state, retryId)).toBe(true);
    expect(isCurrentResponse(retried.state, setup.responseId)).toBe(false);

    const stale = reduceTurnCoordinator(retried.state, {
      type: "response/speaking_started",
      sessionId: SESSION_ID,
      atMs: 13,
      responseId: setup.responseId,
    });
    expect(stale.rejection).toBe("stale_response");
  });

  it("drops an uncommitted acoustic turn when degraded and recovers listening", () => {
    let state = confirmSpeech(initial(), 1).state;
    state = revise(state, 2, 1);
    const degraded = reduceTurnCoordinator(state, {
      type: "session/degraded",
      sessionId: SESSION_ID,
      atMs: 3,
    });
    expect(degraded.state.lifecycle).toBe("degraded");
    expect(degraded.state.turn).toBeNull();
    expect(projectTurnPhase(degraded.state)).toBe("degraded");

    const recovered = reduceTurnCoordinator(degraded.state, {
      type: "session/listening",
      sessionId: SESSION_ID,
      atMs: 4,
    });
    expect(recovered.state.lifecycle).toBe("listening");
    expect(projectTurnPhase(recovered.state)).toBe("listening");
  });

  it("rejects cross-session, stale-ID, and post-close events", () => {
    const setup = responseState();
    const crossSession = reduceTurnCoordinator(setup.state, {
      type: "interrupt/explicit",
      sessionId: "other-session",
      atMs: 10,
      reason: "user_stop",
    });
    expect(crossSession.rejection).toBe("session_mismatch");
    expect(crossSession.state).toBe(setup.state);

    const staleTurn = reduceTurnCoordinator(setup.state, {
      type: "timer/merge_elapsed",
      sessionId: SESSION_ID,
      atMs: 10,
      turnId: `${SESSION_ID}:turn:999` as TurnId,
      turnRevision: 0,
    });
    expect(staleTurn.rejection).toBe("stale_turn");

    const closed = reduceTurnCoordinator(setup.state, {
      type: "session/closed",
      sessionId: SESSION_ID,
      atMs: 10,
    });
    const afterClose = reduceTurnCoordinator(closed.state, {
      type: "speech/confirmed",
      sessionId: SESSION_ID,
      atMs: 11,
      continuation: "new_turn",
    });
    expect(afterClose.rejection).toBe("session_closed");
    expect(afterClose.state).toBe(closed.state);
  });

  it("flushes an exact settled tail on old-timestamp stop and session close", () => {
    const stoppedSetup = responseState({ speaking: true, settle: true });
    const stopped = reduceTurnCoordinator(stoppedSetup.state, {
      type: "interrupt/explicit",
      sessionId: SESSION_ID,
      atMs: 1,
      reason: "user_stop",
    });
    expect(stopped.accepted).toBe(true);
    expect(stopped.state.lastAtMs).toBe(6);
    expect(stopped.state.turn?.lastResponse?.playoutPending).toBe(false);
    expect(stopped.effects).toEqual([
      { type: "playback/flush", responseId: stoppedSetup.responseId },
      { type: "output/retract", responseId: stoppedSetup.responseId },
    ]);

    const closedSetup = responseState({ speaking: true, settle: true });
    const closed = reduceTurnCoordinator(closedSetup.state, {
      type: "session/closed",
      sessionId: SESSION_ID,
      atMs: 1,
    });
    expect(closed.accepted).toBe(true);
    expect(closed.state.lastAtMs).toBe(6);
    expect(closed.state.lifecycle).toBe("closed");
    expect(closed.state.turn?.lastResponse?.playoutPending).toBe(false);
    expect(closed.effects).toEqual([
      { type: "playback/flush", responseId: closedSetup.responseId },
      { type: "output/retract", responseId: closedSetup.responseId },
    ]);
  });

  it("keeps IDs monotonic and never recycles an interrupted response", () => {
    const first = responseState();
    const nextTurn = confirmSpeech(first.state, 10, "new_turn");
    let state = revise(nextTurn.state, 11, 1);
    state = commitResponse(state, 12);
    const secondResponseId = state.response?.id as ResponseId;
    expect(secondResponseId).not.toBe(first.responseId);
    expect(state.counters).toMatchObject({ turn: 2, response: 2 });

    const oldCallback = reduceTurnCoordinator(state, {
      type: "response/model_started",
      sessionId: SESSION_ID,
      atMs: 13,
      responseId: first.responseId,
    });
    expect(oldCallback.rejection).toBe("stale_response");
    expect(state.response?.id).toBe(secondResponseId);
  });

  it("validates initial policy and does not mutate rejected state", () => {
    expect(() =>
      createTurnCoordinatorState({
        sessionId: SESSION_ID,
        atMs: 0,
        policy: { eotMergeWindowMs: 0 },
      }),
    ).toThrow("eotMergeWindowMs");
    const state = initial();
    const noResponse = reduceTurnCoordinator(state, {
      type: "speech/provisional_started",
      sessionId: SESSION_ID,
      atMs: 1,
    });
    expect(noResponse.rejection).toBe("no_interruptible_response");
    expect(noResponse.state).toBe(state);
    expect(noResponse.effects).toEqual([]);
  });
});
