/**
 * Unit tests for `VoiceStateMachine`.
 *
 * Each test drives the machine with synthetic events and asserts on:
 *   - the public state at each step,
 *   - the operations recorded by `MockCheckpointManager` (save/restore/
 *     discard),
 *   - the drafter lifecycle (started / aborted / reason).
 *
 * The four-state flow under test:
 *
 *   IDLE → LISTENING → PAUSE_TENTATIVE → (LISTENING | SPEAKING)
 *   SPEAKING → LISTENING (on barge-in, restores C1)
 */

import { describe, expect, it } from "vitest";
import {
  MockCheckpointManager,
  type CheckpointHandle,
} from "../checkpoint-manager";
import {
  type DrafterAbortReason,
  type DrafterHandle,
  type StartDrafterFn,
  VoiceStateMachine,
} from "../voice-state-machine";

interface DrafterCall {
  turnId: string;
  partial: string;
  aborted: DrafterAbortReason | null;
}

function fakeDrafter(): { fn: StartDrafterFn; calls: DrafterCall[] } {
  const calls: DrafterCall[] = [];
  const fn: StartDrafterFn = ({ turnId, partialTranscript }) => {
    const record: DrafterCall = { turnId, partial: partialTranscript, aborted: null };
    calls.push(record);
    // The state machine always pairs `controller.abort()` with an explicit
    // `handle.abort(reason)` — record only the explicit reason so tests can
    // assert which transition aborted the draft. (Wiring `signal` here too
    // would race with the always-fired AbortController.abort() call.)
    const handle: DrafterHandle = {
      abort(reason) {
        if (record.aborted === null) record.aborted = reason;
      },
    };
    return handle;
  };
  return { fn, calls };
}

interface CapturedEvents {
  states: Array<{ prev: string; next: string }>;
  drafterStarted: string[];
  drafterAborted: Array<{ turnId: string; reason: DrafterAbortReason }>;
  commits: Array<{ turnId: string; transcript: string }>;
  rollbacks: Array<{ turnId: string; handle: CheckpointHandle }>;
  errors: Array<{ op: "save" | "restore" | "discard"; error: unknown }>;
}

function captureEvents(): {
  captured: CapturedEvents;
  events: ConstructorParameters<typeof VoiceStateMachine>[0]["events"];
} {
  const captured: CapturedEvents = {
    states: [],
    drafterStarted: [],
    drafterAborted: [],
    commits: [],
    rollbacks: [],
    errors: [],
  };
  return {
    captured,
    events: {
      onStateChange: (prev, next) =>
        captured.states.push({ prev, next }),
      onDrafterStart: (turnId) => captured.drafterStarted.push(turnId),
      onDrafterAbort: (turnId, reason) =>
        captured.drafterAborted.push({ turnId, reason }),
      onCommit: (turnId, transcript) =>
        captured.commits.push({ turnId, transcript }),
      onRollback: (turnId, handle) =>
        captured.rollbacks.push({ turnId, handle }),
      onError: (op, error) => captured.errors.push({ op, error }),
    },
  };
}

function makeMachine(
  mock = new MockCheckpointManager(),
): {
  machine: VoiceStateMachine;
  mock: MockCheckpointManager;
  drafterCalls: DrafterCall[];
  captured: CapturedEvents;
} {
  const drafter = fakeDrafter();
  const ev = captureEvents();
  const machine = new VoiceStateMachine({
    slotId: "conv-1",
    checkpointManager: mock,
    startDrafter: drafter.fn,
    events: ev.events,
    pauseHangoverMs: 200,
  });
  return {
    machine,
    mock,
    drafterCalls: drafter.calls,
    captured: ev.captured,
  };
}

describe("VoiceStateMachine — happy paths and rollback", () => {
  it("starts in IDLE; speech-start transitions to LISTENING", async () => {
    const { machine } = makeMachine();
    expect(machine.getState()).toBe("IDLE");
    await machine.dispatch({ type: "speech-start", timestampMs: 0 });
    expect(machine.getState()).toBe("LISTENING");
  });

  it("speech-pause saves the C1 checkpoint and starts the drafter", async () => {
    const { machine, mock, drafterCalls } = makeMachine();
    await machine.dispatch({ type: "speech-start", timestampMs: 0 });
    await machine.dispatch({
      type: "speech-pause",
      timestampMs: 1000,
      partialTranscript: "how do I",
    });
    expect(machine.getState()).toBe("PAUSE_TENTATIVE");
    expect(mock.operations).toContainEqual({
      kind: "save",
      slotId: "conv-1",
      name: "pre-draft",
      handleId: 1,
    });
    expect(drafterCalls).toHaveLength(1);
    expect(drafterCalls[0].partial).toBe("how do I");
    expect(machine.getActiveCheckpoint()).not.toBeNull();
  });

  it("speech-active within rollback window discards C1 and returns to LISTENING", async () => {
    const { machine, mock, drafterCalls, captured } = makeMachine();
    await machine.dispatch({ type: "speech-start", timestampMs: 0 });
    await machine.dispatch({
      type: "speech-pause",
      timestampMs: 1000,
      partialTranscript: "how do I",
    });
    // Rollback window is 2 * 200ms = 400ms; arrive at 200ms (within window).
    await machine.dispatch({ type: "speech-active", timestampMs: 1200 });
    expect(machine.getState()).toBe("LISTENING");
    expect(mock.operations.filter((op) => op.kind === "discard")).toHaveLength(
      1,
    );
    expect(machine.getActiveCheckpoint()).toBeNull();
    // Drafter was aborted with reason "resumed".
    expect(drafterCalls[0].aborted).toBe("resumed");
    expect(
      captured.drafterAborted.some((d) => d.reason === "resumed"),
    ).toBe(true);
  });

  it("speech-end commits the turn and retains C1 for barge-in", async () => {
    const { machine, mock, captured } = makeMachine();
    await machine.dispatch({ type: "speech-start", timestampMs: 0 });
    await machine.dispatch({
      type: "speech-pause",
      timestampMs: 1000,
      partialTranscript: "how do I",
    });
    await machine.dispatch({
      type: "speech-end",
      timestampMs: 1500,
      finalTranscript: "how do I bake bread",
    });
    expect(machine.getState()).toBe("SPEAKING");
    // C1 is retained.
    expect(machine.getActiveCheckpoint()).not.toBeNull();
    expect(mock.liveHandleCount()).toBe(1);
    // No discard happened — the only operation should be the save.
    expect(mock.operations.filter((op) => op.kind === "discard")).toHaveLength(
      0,
    );
    expect(captured.commits).toEqual([
      { turnId: "turn-1", transcript: "how do I bake bread" },
    ]);
  });

  it("barge-in mid-SPEAKING restores C1 and re-enters LISTENING with a new turn id", async () => {
    const { machine, mock, drafterCalls, captured } = makeMachine();
    await machine.dispatch({ type: "speech-start", timestampMs: 0 });
    await machine.dispatch({
      type: "speech-pause",
      timestampMs: 1000,
      partialTranscript: "how do I",
    });
    await machine.dispatch({
      type: "speech-end",
      timestampMs: 1500,
      finalTranscript: "how do I bake bread",
    });
    const turnBeforeBarge = machine.getTurnId();
    expect(turnBeforeBarge).toBe("turn-1");

    await machine.dispatch({ type: "barge-in", timestampMs: 2200 });
    expect(machine.getState()).toBe("LISTENING");
    expect(mock.operations.filter((op) => op.kind === "restore")).toHaveLength(
      1,
    );
    expect(captured.rollbacks).toHaveLength(1);
    expect(captured.rollbacks[0].handle.name).toBe("pre-draft");
    expect(machine.getTurnId()).toBe("turn-2");
    // Drafter was aborted with barge-in reason.
    expect(drafterCalls[0].aborted).toBe("barge-in");
  });

  it("two consecutive barge-ins restore the same C1 twice", async () => {
    const { machine, mock } = makeMachine();
    await machine.dispatch({ type: "speech-start", timestampMs: 0 });
    await machine.dispatch({
      type: "speech-pause",
      timestampMs: 1000,
      partialTranscript: "how do I",
    });
    await machine.dispatch({
      type: "speech-end",
      timestampMs: 1500,
      finalTranscript: "how do I bake bread",
    });
    const c1 = machine.getActiveCheckpoint();
    expect(c1).not.toBeNull();

    // First barge-in.
    await machine.dispatch({ type: "barge-in", timestampMs: 2000 });
    expect(machine.getState()).toBe("LISTENING");
    expect(machine.getActiveCheckpoint()).toBe(c1);

    // Second turn: speech-start, then speech-end without pause means no new
    // C1; we go straight to SPEAKING but retain the original C1.
    await machine.dispatch({ type: "speech-start", timestampMs: 2100 });
    await machine.dispatch({
      type: "speech-end",
      timestampMs: 2400,
      finalTranscript: "wait, actually...",
    });
    expect(machine.getState()).toBe("SPEAKING");

    // Second barge-in restores the same C1.
    await machine.dispatch({ type: "barge-in", timestampMs: 2500 });
    expect(machine.getState()).toBe("LISTENING");
    expect(
      mock.operations.filter((op) => op.kind === "restore"),
    ).toHaveLength(2);
    // Both restores target the same handle id.
    const restoreOps = mock.operations.filter((op) => op.kind === "restore");
    expect(restoreOps[0].handleId).toBe(restoreOps[1].handleId);
  });

  it("speech-active outside the rollback window promotes to SPEAKING without rollback", async () => {
    const { machine, mock } = makeMachine();
    await machine.dispatch({ type: "speech-start", timestampMs: 0 });
    await machine.dispatch({
      type: "speech-pause",
      timestampMs: 1000,
      partialTranscript: "how do I",
    });
    // Window is 2 * 200ms = 400ms; arrive at 500ms (outside).
    await machine.dispatch({ type: "speech-active", timestampMs: 1500 });
    expect(machine.getState()).toBe("SPEAKING");
    expect(mock.operations.filter((op) => op.kind === "discard")).toHaveLength(
      0,
    );
  });

  it("dispose aborts the drafter and discards an outstanding C1", async () => {
    const { machine, mock, drafterCalls } = makeMachine();
    await machine.dispatch({ type: "speech-start", timestampMs: 0 });
    await machine.dispatch({
      type: "speech-pause",
      timestampMs: 1000,
      partialTranscript: "how do I",
    });
    await machine.dispose();
    expect(machine.getState()).toBe("IDLE");
    expect(mock.liveHandleCount()).toBe(0);
    expect(drafterCalls[0].aborted).toBe("shutdown");
  });

  it("checkpoints disabled: state machine still transitions but never touches the manager", async () => {
    const mock = new MockCheckpointManager();
    const drafter = fakeDrafter();
    const machine = new VoiceStateMachine({
      slotId: "conv-1",
      checkpointManager: mock,
      startDrafter: drafter.fn,
      enableCheckpoints: false,
      pauseHangoverMs: 200,
    });
    await machine.dispatch({ type: "speech-start", timestampMs: 0 });
    await machine.dispatch({
      type: "speech-pause",
      timestampMs: 1000,
      partialTranscript: "how do I",
    });
    await machine.dispatch({
      type: "speech-end",
      timestampMs: 1500,
      finalTranscript: "how do I bake bread",
    });
    await machine.dispatch({ type: "barge-in", timestampMs: 2000 });
    expect(machine.getState()).toBe("LISTENING");
    // No manager activity.
    expect(mock.operations).toHaveLength(0);
    // Drafter still ran.
    expect(drafter.calls).toHaveLength(1);
    expect(drafter.calls[0].aborted).toBe("barge-in");
  });

  it("a save failure surfaces via onError but does not block state transitions", async () => {
    const failingMock: MockCheckpointManager = Object.assign(
      new MockCheckpointManager(),
      {
        saveCheckpoint: async () => {
          throw new Error("simulated save failure");
        },
      },
    );
    const drafter = fakeDrafter();
    const ev = captureEvents();
    const machine = new VoiceStateMachine({
      slotId: "conv-1",
      checkpointManager: failingMock,
      startDrafter: drafter.fn,
      events: ev.events,
      pauseHangoverMs: 200,
    });
    await machine.dispatch({ type: "speech-start", timestampMs: 0 });
    await machine.dispatch({
      type: "speech-pause",
      timestampMs: 1000,
      partialTranscript: "how do I",
    });
    // State advanced despite the failure; error surfaced.
    expect(machine.getState()).toBe("PAUSE_TENTATIVE");
    expect(ev.captured.errors).toHaveLength(1);
    expect(ev.captured.errors[0].op).toBe("save");
    // Drafter still kicked.
    expect(drafter.calls).toHaveLength(1);
  });
});
