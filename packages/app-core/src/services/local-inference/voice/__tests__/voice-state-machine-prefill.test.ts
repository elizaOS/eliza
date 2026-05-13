/**
 * Integration tests: VoiceStateMachine + C7 optimistic prefill.
 *
 * Tests the three key integration scenarios:
 *
 *   1. PAUSE_TENTATIVE entry fires `prefillOptimistic` (verifiable via
 *      MockCheckpointManager — phase 1 + phase 3 saves appear).
 *
 *   2. SPEECH_ACTIVE_REBOUND (within rollback window): the in-flight prefill
 *      is discarded; C1 is restored; the machine returns to LISTENING.
 *
 *   3. SPEECH_END: the machine awaits the prefill result and passes it to
 *      `onCommit(prefillResult)` so the verifier can resume from the
 *      prefilled KV state.
 */

import { describe, expect, it, vi } from "vitest";
import { MockCheckpointManager } from "../checkpoint-manager";
import type {
  DrafterAbortReason,
  DrafterHandle,
  StartDrafterFn,
  PrefillOptimisticResult,
} from "../voice-state-machine";
import { VoiceStateMachine } from "../voice-state-machine";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakeDrafter(): {
  fn: StartDrafterFn;
  calls: Array<{ turnId: string; aborted: DrafterAbortReason | null }>;
} {
  const calls: Array<{ turnId: string; aborted: DrafterAbortReason | null }> = [];
  const fn: StartDrafterFn = ({ turnId }) => {
    const rec = { turnId, aborted: null as DrafterAbortReason | null };
    calls.push(rec);
    const handle: DrafterHandle = {
      abort(reason) {
        if (rec.aborted === null) rec.aborted = reason;
      },
    };
    return handle;
  };
  return { fn, calls };
}

function okFetch(): typeof fetch {
  return vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ content: "" }), { status: 200 }),
  ) as typeof fetch;
}

function makeMachineWithPrefill(mgr = new MockCheckpointManager()) {
  const drafter = fakeDrafter();
  const commits: Array<{
    turnId: string;
    transcript: string;
    prefillResult?: PrefillOptimisticResult;
  }> = [];
  const rollbacks: Array<{ turnId: string }> = [];
  const prefillEvents: Array<{
    turnId: string;
    result: PrefillOptimisticResult | null;
    error: unknown;
  }> = [];

  const machine = new VoiceStateMachine({
    slotId: "conv-prefill",
    checkpointManager: mgr,
    startDrafter: drafter.fn,
    pauseHangoverMs: 200,
    prefillConfig: {
      baseUrl: "http://localhost:8080",
      checkpointOptions: {
        fetchImpl: okFetch(),
      },
    },
    events: {
      onCommit(turnId, transcript, prefillResult) {
        commits.push({ turnId, transcript, prefillResult });
      },
      onRollback(turnId) {
        rollbacks.push({ turnId });
      },
      onPrefill(turnId, result, error) {
        prefillEvents.push({ turnId, result, error });
      },
    },
  });

  return { machine, mgr, drafter, commits, rollbacks, prefillEvents };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("VoiceStateMachine + C7 prefill integration", () => {
  it("PAUSE_TENTATIVE entry fires prefillOptimistic — two saves appear in the checkpoint manager", async () => {
    const mgr = new MockCheckpointManager();
    const { machine } = makeMachineWithPrefill(mgr);

    await machine.dispatch({ type: "speech-start", timestampMs: 0 });
    await machine.dispatch({
      type: "speech-pause",
      timestampMs: 1000,
      partialTranscript: "how do I bake",
    });

    // Allow the async prefill to settle.
    await new Promise((r) => setTimeout(r, 20));

    expect(machine.getState()).toBe("PAUSE_TENTATIVE");

    // C1 (pre-draft) from the voice state machine + pre-prefill + post-prefill
    // from prefillOptimistic. Order: pre-draft, pre-prefill, post-prefill.
    const saves = mgr.operations.filter((op) => op.kind === "save");
    // At minimum the pre-prefill and post-prefill saves from prefillOptimistic.
    const prefillSaves = saves.filter(
      (s) => s.name === "pre-prefill" || s.name === "post-prefill",
    );
    expect(prefillSaves).toHaveLength(2);
    expect(prefillSaves[0].name).toBe("pre-prefill");
    expect(prefillSaves[1].name).toBe("post-prefill");
  });

  it("PAUSE_TENTATIVE → onPrefill fires with the prefill result", async () => {
    const { machine, prefillEvents } = makeMachineWithPrefill();

    await machine.dispatch({ type: "speech-start", timestampMs: 0 });
    await machine.dispatch({
      type: "speech-pause",
      timestampMs: 1000,
      partialTranscript: "how do I bake",
    });

    // Allow the async prefill to settle.
    await new Promise((r) => setTimeout(r, 20));

    expect(prefillEvents).toHaveLength(1);
    expect(prefillEvents[0].result).not.toBeNull();
    expect(prefillEvents[0].error).toBeNull();
    const result = prefillEvents[0].result!;
    expect(result.eotProb).toBeCloseTo(0.5, 1); // latestEotProb default = 0.5
    expect(result.tokenCount).toBeGreaterThanOrEqual(1);
  });

  it("SPEECH_END awaits the prefill and passes the result to onCommit", async () => {
    const { machine, commits } = makeMachineWithPrefill();

    await machine.dispatch({ type: "speech-start", timestampMs: 0 });
    await machine.dispatch({
      type: "speech-pause",
      timestampMs: 1000,
      partialTranscript: "how do I bake",
    });
    await machine.dispatch({
      type: "speech-end",
      timestampMs: 1500,
      finalTranscript: "how do I bake bread",
    });

    expect(machine.getState()).toBe("SPEAKING");
    expect(commits).toHaveLength(1);
    expect(commits[0].transcript).toBe("how do I bake bread");
    // The prefill result is attached.
    expect(commits[0].prefillResult).toBeDefined();
    expect(commits[0].prefillResult?.backend).toBe("slot-save-stub");
    expect(commits[0].prefillResult?.checkpointHandle).toBeDefined();
  });

  it("SPEECH_ACTIVE_REBOUND (within window): prefill in-flight is discarded, C1 is restored, returns to LISTENING", async () => {
    const mgr = new MockCheckpointManager();
    const { machine, drafter } = makeMachineWithPrefill(mgr);

    await machine.dispatch({ type: "speech-start", timestampMs: 0 });
    await machine.dispatch({
      type: "speech-pause",
      timestampMs: 1000,
      partialTranscript: "how do I",
    });
    // Rebound within 2 × 200ms = 400ms window.
    await machine.dispatch({ type: "speech-active", timestampMs: 1200 });

    expect(machine.getState()).toBe("LISTENING");
    // Drafter was aborted.
    expect(drafter.calls[0].aborted).toBe("resumed");
    // C1 was discarded (not just the prefill). In the mock, discard is called.
    expect(mgr.operations.some((op) => op.kind === "discard")).toBe(true);
  });

  it("barge-in on SPEAKING restores C1 (pre-draft, not post-prefill)", async () => {
    const mgr = new MockCheckpointManager();
    const { machine } = makeMachineWithPrefill(mgr);

    await machine.dispatch({ type: "speech-start", timestampMs: 0 });
    await machine.dispatch({
      type: "speech-pause",
      timestampMs: 1000,
      partialTranscript: "bake bread",
    });
    await machine.dispatch({
      type: "speech-end",
      timestampMs: 1500,
      finalTranscript: "how to bake bread",
    });
    expect(machine.getState()).toBe("SPEAKING");

    await machine.dispatch({ type: "barge-in", timestampMs: 2200 });
    expect(machine.getState()).toBe("LISTENING");

    // A restore was called.
    const restores = mgr.operations.filter((op) => op.kind === "restore");
    expect(restores).toHaveLength(1);
    // The restored handle should be the C1 (pre-draft) handle, not the post-prefill handle.
    // The pre-draft save is the first "pre-draft" named save.
    const preDraftSave = mgr.operations.find(
      (op) => op.kind === "save" && op.name === "pre-draft",
    );
    expect(preDraftSave).toBeDefined();
    expect(restores[0].handleId).toBe(preDraftSave!.handleId);
  });

  it("works normally when no prefillConfig is provided (backward compat)", async () => {
    const mgr = new MockCheckpointManager();
    const drafter = fakeDrafter();
    const commits: Array<{ prefillResult?: PrefillOptimisticResult }> = [];
    const machine = new VoiceStateMachine({
      slotId: "conv-no-prefill",
      checkpointManager: mgr,
      startDrafter: drafter.fn,
      pauseHangoverMs: 200,
      events: {
        onCommit(turnId, transcript, prefillResult) {
          commits.push({ prefillResult });
        },
      },
    });

    await machine.dispatch({ type: "speech-start", timestampMs: 0 });
    await machine.dispatch({
      type: "speech-pause",
      timestampMs: 1000,
      partialTranscript: "hello",
    });
    await machine.dispatch({
      type: "speech-end",
      timestampMs: 1500,
      finalTranscript: "hello world",
    });

    expect(machine.getState()).toBe("SPEAKING");
    expect(commits[0].prefillResult).toBeUndefined();
    // Only C1 (pre-draft) save — no prefill saves.
    const saves = mgr.operations.filter((op) => op.kind === "save");
    expect(saves).toHaveLength(1);
    expect(saves[0].name).toBe("pre-draft");
  });
});
