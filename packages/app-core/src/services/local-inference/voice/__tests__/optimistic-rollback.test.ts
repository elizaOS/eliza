/**
 * Unit tests for `OptimisticRollbackController`. Drives a mocked VAD source
 * and a mocked `CheckpointClient`; asserts state transitions, REST calls,
 * speculative-drafter lifecycle, and rollback-window timing.
 */

import { describe, expect, it, vi } from "vitest";
import type {
  CheckpointClient,
  CheckpointHandle,
} from "../../dflash-checkpoint-client";
import {
  type AbortReason,
  OptimisticRollbackController,
  type OptimisticRollbackTelemetry,
  type SpeculativeDraftHandle,
} from "../optimistic-rollback";
import type { VadEvent, VadEventListener, VadEventSource } from "../types";

class FakeVadSource implements VadEventSource {
  private listeners = new Set<VadEventListener>();
  onVadEvent(listener: VadEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  emit(event: VadEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

interface MockClientCalls {
  save: Array<{ slotId: number; name: string }>;
  restore: Array<{ slotId: number; name: string }>;
  cancel: number[];
}

function makeClient(opts: {
  calls: MockClientCalls;
  saveImpl?: () => Promise<CheckpointHandle>;
  restoreImpl?: () => Promise<void>;
}): CheckpointClient {
  return {
    saveCheckpoint: async (slotId: number, name: string) => {
      opts.calls.save.push({ slotId, name });
      if (opts.saveImpl) return opts.saveImpl();
      return { slotId, filename: name, createdAt: "2026-05-12T00:00:00.000Z" };
    },
    restoreCheckpoint: async (slotId: number, name: string) => {
      opts.calls.restore.push({ slotId, name });
      if (opts.restoreImpl) return opts.restoreImpl();
    },
    cancelSlot: async (slotId: number) => {
      opts.calls.cancel.push(slotId);
    },
    probeSupported: async () => true,
  } as unknown as CheckpointClient;
}

function captureTelemetry(): {
  events: Array<
    | { kind: "saved"; turnId: string }
    | { kind: "restored"; turnId: string }
    | { kind: "draftStarted"; turnId: string }
    | { kind: "draftAborted"; turnId: string; reason: AbortReason }
    | { kind: "error"; op: "save" | "restore" | "cancel" }
  >;
  telemetry: OptimisticRollbackTelemetry;
} {
  const events: Array<
    | { kind: "saved"; turnId: string }
    | { kind: "restored"; turnId: string }
    | { kind: "draftStarted"; turnId: string }
    | { kind: "draftAborted"; turnId: string; reason: AbortReason }
    | { kind: "error"; op: "save" | "restore" | "cancel" }
  > = [];
  return {
    events,
    telemetry: {
      onCheckpointSaved: (_handle, turnId) =>
        events.push({ kind: "saved", turnId }),
      onCheckpointRestored: (_handle, turnId) =>
        events.push({ kind: "restored", turnId }),
      onSpeculativeDraftStarted: (turnId) =>
        events.push({ kind: "draftStarted", turnId }),
      onSpeculativeDraftAborted: (turnId, reason) =>
        events.push({ kind: "draftAborted", turnId, reason }),
      onCheckpointError: (op) => events.push({ kind: "error", op }),
    },
  };
}

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("OptimisticRollbackController", () => {
  it("pause → save, active-within-window → restore + abort, then idle", async () => {
    const vad = new FakeVadSource();
    const calls: MockClientCalls = { save: [], restore: [], cancel: [] };
    const client = makeClient({ calls });
    const draftAbort = vi.fn();
    const startDraft = vi.fn(
      (): SpeculativeDraftHandle => ({ abort: draftAbort }),
    );
    const { events, telemetry } = captureTelemetry();
    const controller = new OptimisticRollbackController({
      slotId: 2,
      enableOptimisticRollback: true,
      pauseHangoverMs: 200,
      vadSource: vad,
      client,
      startSpeculativeDraft: startDraft,
      readPartialTranscript: () => "hello world",
      telemetry,
    });

    vad.emit({ type: "speech-start", timestampMs: 1000, probability: 0.9 });
    expect(controller.getState()).toBe("listening");

    vad.emit({ type: "speech-pause", timestampMs: 1500, pauseDurationMs: 0 });
    expect(controller.getState()).toBe("pause-tentative");
    await flushPromises();
    expect(controller.getState()).toBe("draft-response");
    expect(calls.save).toEqual([{ slotId: 2, name: "C1-turn-1" }]);
    expect(startDraft).toHaveBeenCalledWith("hello world", "turn-1");

    // 350ms later (< 2 × 200ms window) — user resumes.
    vad.emit({
      type: "speech-active",
      timestampMs: 1850,
      probability: 0.95,
      speechDurationMs: 600,
    });
    expect(controller.getState()).toBe("listening");
    expect(draftAbort).toHaveBeenCalledOnce();
    await flushPromises();
    expect(calls.restore).toEqual([{ slotId: 2, name: "C1-turn-1" }]);

    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("saved");
    expect(kinds).toContain("draftStarted");
    expect(kinds).toContain("draftAborted");
    expect(kinds).toContain("restored");
  });

  it("active outside rollback window commits instead of restoring", async () => {
    const vad = new FakeVadSource();
    const calls: MockClientCalls = { save: [], restore: [], cancel: [] };
    const client = makeClient({ calls });
    const draftAbort = vi.fn();
    const startDraft = vi.fn(
      (): SpeculativeDraftHandle => ({ abort: draftAbort }),
    );
    const controller = new OptimisticRollbackController({
      slotId: 1,
      enableOptimisticRollback: true,
      pauseHangoverMs: 200,
      vadSource: vad,
      client,
      startSpeculativeDraft: startDraft,
      readPartialTranscript: () => "stale",
    });

    vad.emit({ type: "speech-start", timestampMs: 0, probability: 0.9 });
    vad.emit({ type: "speech-pause", timestampMs: 1000, pauseDurationMs: 0 });
    await flushPromises();
    // 600ms later — > 2 × 200ms window. Commit, don't restore.
    vad.emit({
      type: "speech-active",
      timestampMs: 1600,
      probability: 0.9,
      speechDurationMs: 100,
    });
    await flushPromises();
    expect(calls.restore).toHaveLength(0);
    expect(draftAbort).not.toHaveBeenCalled();
    expect(controller.getState()).toBe("idle");
  });

  it("speech-end commits — drops snapshot, leaves drafter to flow", async () => {
    const vad = new FakeVadSource();
    const calls: MockClientCalls = { save: [], restore: [], cancel: [] };
    const client = makeClient({ calls });
    const draftAbort = vi.fn();
    const startDraft = vi.fn(
      (): SpeculativeDraftHandle => ({ abort: draftAbort }),
    );
    const controller = new OptimisticRollbackController({
      slotId: 0,
      enableOptimisticRollback: true,
      vadSource: vad,
      client,
      startSpeculativeDraft: startDraft,
      readPartialTranscript: () => "done",
    });

    vad.emit({ type: "speech-start", timestampMs: 0, probability: 0.9 });
    vad.emit({ type: "speech-pause", timestampMs: 500, pauseDurationMs: 0 });
    await flushPromises();
    vad.emit({ type: "speech-end", timestampMs: 800, speechDurationMs: 500 });
    expect(calls.restore).toHaveLength(0);
    expect(draftAbort).not.toHaveBeenCalled();
    expect(controller.getState()).toBe("idle");
  });

  it("feature flag off: no REST calls, no draft, state still advances", async () => {
    const vad = new FakeVadSource();
    const calls: MockClientCalls = { save: [], restore: [], cancel: [] };
    const client = makeClient({ calls });
    const startDraft = vi.fn(
      (): SpeculativeDraftHandle => ({ abort: vi.fn() }),
    );
    const controller = new OptimisticRollbackController({
      slotId: 0,
      enableOptimisticRollback: false,
      vadSource: vad,
      client,
      startSpeculativeDraft: startDraft,
      readPartialTranscript: () => "ignored",
    });

    vad.emit({ type: "speech-start", timestampMs: 0, probability: 0.9 });
    vad.emit({ type: "speech-pause", timestampMs: 500, pauseDurationMs: 0 });
    await flushPromises();
    expect(calls.save).toHaveLength(0);
    expect(startDraft).not.toHaveBeenCalled();
    expect(controller.getState()).toBe("pause-tentative");

    vad.emit({ type: "speech-end", timestampMs: 800, speechDurationMs: 500 });
    expect(calls.restore).toHaveLength(0);
    expect(controller.getState()).toBe("idle");
  });

  it("save failure surfaces via onCheckpointError without throwing", async () => {
    const vad = new FakeVadSource();
    const calls: MockClientCalls = { save: [], restore: [], cancel: [] };
    const client = makeClient({
      calls,
      saveImpl: async () => {
        throw new Error("connection refused");
      },
    });
    const { events, telemetry } = captureTelemetry();
    const controller = new OptimisticRollbackController({
      slotId: 0,
      enableOptimisticRollback: true,
      vadSource: vad,
      client,
      startSpeculativeDraft: () => ({ abort: vi.fn() }),
      readPartialTranscript: () => "x",
      telemetry,
    });
    vad.emit({ type: "speech-start", timestampMs: 0, probability: 0.9 });
    vad.emit({ type: "speech-pause", timestampMs: 100, pauseDurationMs: 0 });
    await flushPromises();
    expect(events.find((e) => e.kind === "error")).toMatchObject({
      kind: "error",
      op: "save",
    });
    expect(controller.getState()).toBe("pause-tentative");
  });

  it("dispose detaches and aborts in-flight draft", async () => {
    const vad = new FakeVadSource();
    const calls: MockClientCalls = { save: [], restore: [], cancel: [] };
    const client = makeClient({ calls });
    const draftAbort = vi.fn();
    const controller = new OptimisticRollbackController({
      slotId: 4,
      enableOptimisticRollback: true,
      vadSource: vad,
      client,
      startSpeculativeDraft: () => ({ abort: draftAbort }),
      readPartialTranscript: () => "x",
    });
    vad.emit({ type: "speech-start", timestampMs: 0, probability: 0.9 });
    vad.emit({ type: "speech-pause", timestampMs: 100, pauseDurationMs: 0 });
    await flushPromises();
    controller.dispose();
    expect(draftAbort).toHaveBeenCalled();
    expect(calls.cancel).toEqual([4]);
    // Dispose is idempotent
    controller.dispose();
    expect(calls.cancel).toHaveLength(1);
  });

  it("blip and stray speech-active heartbeats are ignored", async () => {
    const vad = new FakeVadSource();
    const calls: MockClientCalls = { save: [], restore: [], cancel: [] };
    const client = makeClient({ calls });
    const controller = new OptimisticRollbackController({
      slotId: 0,
      enableOptimisticRollback: true,
      vadSource: vad,
      client,
      startSpeculativeDraft: () => ({ abort: vi.fn() }),
      readPartialTranscript: () => "x",
    });
    vad.emit({ type: "blip", timestampMs: 0, durationMs: 10, peakRms: 0.1 });
    expect(controller.getState()).toBe("idle");
    vad.emit({ type: "speech-start", timestampMs: 0, probability: 0.9 });
    vad.emit({
      type: "speech-active",
      timestampMs: 100,
      probability: 0.95,
      speechDurationMs: 100,
    });
    // listening heartbeat — no REST.
    expect(calls.save).toHaveLength(0);
    expect(controller.getState()).toBe("listening");
  });
});
