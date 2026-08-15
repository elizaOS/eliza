import { describe, expect, test } from "bun:test";
import type { TurnCoordinatorEffect } from "@elizaos/shared/voice/turn-coordinator";
import {
  type VoiceResponseLease,
  VoiceSessionTurnAuthority,
} from "../lib/turn-authority";

function createAuthority(
  onEffect?: (
    effect: TurnCoordinatorEffect,
    authority: VoiceSessionTurnAuthority,
  ) => void,
) {
  let now = 1_000;
  return {
    authority: new VoiceSessionTurnAuthority({
      sessionId: "voice-session-test",
      now: () => now,
      onEffect,
    }),
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("VoiceSessionTurnAuthority", () => {
  test("publishes revoked state before cancellation effects", () => {
    let lease: VoiceResponseLease | null = null;
    const observations: boolean[] = [];
    const { authority } = createAuthority((effect, current) => {
      if (effect.type === "model/abort" && lease) {
        observations.push(current.isCurrent(lease));
      }
    });
    lease = authority.commitResponse("trace-1");

    expect(authority.explicitInterrupt()).toBe(lease);
    expect(observations).toEqual([false]);
  });

  test("rejects stale model, speech, audio, and settlement callbacks", () => {
    const { authority } = createAuthority();
    const stale = authority.commitResponse("trace-stale");
    authority.explicitInterrupt();

    expect(authority.markModelStarted(stale)).toBe(false);
    expect(authority.markSpeakingStarted(stale)).toBe(false);
    expect(authority.markAudioEnqueued(stale)).toBe(false);
    expect(authority.settle(stale, "spoken")).toBe(false);
  });

  test("revokes one exact response only once for confirmed speech", () => {
    const { authority } = createAuthority();
    const lease = authority.commitResponse("trace-confirmed");
    expect(authority.provisionalSpeechStarted()).not.toBeNull();

    expect(authority.confirmSpeech()).toBe(lease);
    expect(authority.confirmSpeech()).toBeNull();
    expect(authority.isCurrent(lease)).toBe(false);
  });

  test("retains the response when provisional speech is rejected as noise", () => {
    const { authority } = createAuthority();
    const lease = authority.commitResponse("trace-noise");

    expect(authority.provisionalSpeechStarted()).not.toBeNull();
    expect(authority.rejectProvisionalSpeech()).toBe(true);
    expect(authority.isCurrent(lease)).toBe(true);
  });

  test("continues the same turn with a new revision inside the merge window", () => {
    const { authority, advance } = createAuthority();
    const first = authority.commitResponse("trace-first");
    advance(100);

    expect(authority.confirmSpeech("auto")).toBe(first);
    const replacement = authority.commitResponse("trace-replacement");

    expect(replacement.turnId).toBe(first.turnId);
    expect(replacement.turnRevision).toBe(first.turnRevision + 1);
    expect(replacement.responseId).not.toBe(first.responseId);
  });

  test("opens a new turn when continuation arrives after the merge window", () => {
    const { authority, advance } = createAuthority();
    const first = authority.commitResponse("trace-first");
    advance(901);

    expect(authority.confirmSpeech("auto")).toBe(first);
    const replacement = authority.commitResponse("trace-replacement");

    expect(replacement.turnId).not.toBe(first.turnId);
    expect(replacement.turnRevision).toBe(0);
  });

  test("keeps protocol trace ids stable while using distinct internal ids", () => {
    const { authority } = createAuthority();
    const first = authority.commitResponse("opaque-v1-trace");
    authority.settle(first, "spoken");
    const second = authority.commitResponse("another-v1-trace");

    expect(first.traceId).toBe("opaque-v1-trace");
    expect(second.traceId).toBe("another-v1-trace");
    expect(second.responseId).not.toBe(first.responseId);
  });

  test("explicit barge-in revokes the current lease and remains idempotent", () => {
    const { authority } = createAuthority();
    const lease = authority.commitResponse("trace-explicit");

    expect(authority.explicitInterrupt()).toBe(lease);
    expect(authority.explicitInterrupt()).toBeNull();
  });

  test("aborts response-scoped reads but detaches committed mutations", () => {
    const effects: TurnCoordinatorEffect[] = [];
    let now = 1_000;
    const authority = new VoiceSessionTurnAuthority({
      sessionId: "voice-task-test",
      now: () => now,
      sealCommittedTurns: true,
      onEffect: (effect) => effects.push(effect),
    });
    const readLease = authority.commitResponse("trace-read");
    now += 2;
    expect(
      authority.requestTask(readLease, "read-call", {
        lifetime: "response",
        effect: "read_only",
        restartable: true,
      }),
    ).toBe(true);
    const readTaskId = Object.values(authority.state.tasks)[0]?.id;
    authority.explicitInterrupt();
    expect(effects).toContainEqual({ type: "task/abort", taskId: readTaskId });

    effects.length = 0;
    const mutationLease = authority.commitResponse("trace-mutation");
    now += 2;
    expect(
      authority.requestTask(mutationLease, "mutation-call", {
        lifetime: "response",
        effect: "mutating",
        restartable: false,
      }),
    ).toBe(true);
    const mutationTaskId = Object.values(authority.state.tasks)[0]?.id;
    expect(authority.markTaskCommitCrossed("mutation-call")).toBe(true);
    authority.explicitInterrupt();
    expect(effects).toContainEqual({
      type: "task/detach",
      taskId: mutationTaskId,
    });
    expect(effects).toContainEqual({
      type: "task/report_actual_state",
      taskId: mutationTaskId,
    });
  });

  test("settles one exact tool call once and routes its result to the response", () => {
    const effects: TurnCoordinatorEffect[] = [];
    let now = 1_000;
    const authority = new VoiceSessionTurnAuthority({
      sessionId: "voice-task-settle",
      now: () => now,
      sealCommittedTurns: true,
      onEffect: (effect) => effects.push(effect),
    });
    const lease = authority.commitResponse("trace-task");
    now += 2;
    expect(
      authority.requestTask(lease, "call-1", {
        lifetime: "response",
        effect: "read_only",
        restartable: true,
      }),
    ).toBe(true);
    const taskId = Object.values(authority.state.tasks)[0]?.id;
    expect(authority.settleTask("call-1")).toBe(true);
    expect(authority.settleTask("call-1")).toBe(false);
    expect(effects).toContainEqual({
      type: "task/result_available",
      taskId,
      responseId: lease.responseId,
      delivery: "response_router",
    });
  });
});
