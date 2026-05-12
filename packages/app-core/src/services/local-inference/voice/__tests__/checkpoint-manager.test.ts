/**
 * Unit tests for `CheckpointManager` (REST-backed) and
 * `MockCheckpointManager` (in-memory).
 *
 * `CheckpointManager` is verified by stubbing the underlying fetch and
 * asserting the REST URLs / methods. `MockCheckpointManager` is verified
 * by save/restore/discard round-trips that check the recorded operations
 * + the snapshot replay semantics.
 */

import { describe, expect, it } from "vitest";
import type { CheckpointFetch } from "../../dflash-checkpoint-client";
import {
  CheckpointHandleInvalidError,
  CheckpointManager,
  MockCheckpointManager,
} from "../checkpoint-manager";
import { prefillOptimistic } from "../prefill-client";

interface RecordedRequest {
  url: string;
  method: string | undefined;
}

function makeFetch(recorded: RecordedRequest[]): CheckpointFetch {
  return async (url, init) => {
    recorded.push({ url: String(url), method: init?.method });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      async text() {
        return "{}";
      },
    };
  };
}

describe("CheckpointManager (REST-backed)", () => {
  it("saveCheckpoint hits POST /slots/<id>/save and returns a live handle", async () => {
    const recorded: RecordedRequest[] = [];
    const mgr = new CheckpointManager({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: makeFetch(recorded),
      resolveSlotId: () => 3,
    });
    const handle = await mgr.saveCheckpoint("conv-1", "pre-draft");
    expect(handle.slotId).toBe("conv-1");
    expect(handle.name).toBe("pre-draft");
    expect(handle.backendRef?.slotId).toBe(3);
    expect(handle.backendRef?.filename).toMatch(/^C1-conv-1-pre-draft-/);
    expect(recorded).toHaveLength(1);
    expect(recorded[0].method).toBe("POST");
    expect(recorded[0].url).toMatch(/\/slots\/3\/save\?filename=/);
  });

  it("restoreCheckpoint hits POST /slots/<id>/restore against the saved filename", async () => {
    const recorded: RecordedRequest[] = [];
    const mgr = new CheckpointManager({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: makeFetch(recorded),
      resolveSlotId: () => 5,
    });
    const handle = await mgr.saveCheckpoint("conv-2", "pre-draft");
    await mgr.restoreCheckpoint(handle);
    expect(recorded).toHaveLength(2);
    expect(recorded[1].method).toBe("POST");
    expect(recorded[1].url).toMatch(/\/slots\/5\/restore\?filename=/);
    expect(recorded[1].url).toContain(handle.backendRef!.filename);
  });

  it("discardCheckpoint hits DELETE /slots/<id> and invalidates the handle", async () => {
    const recorded: RecordedRequest[] = [];
    const mgr = new CheckpointManager({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: makeFetch(recorded),
      resolveSlotId: () => 7,
    });
    const handle = await mgr.saveCheckpoint("conv-3", "pre-draft");
    await mgr.discardCheckpoint(handle);
    expect(recorded.at(-1)?.method).toBe("DELETE");
    expect(recorded.at(-1)?.url).toBe("http://127.0.0.1:9999/slots/7");
    await expect(mgr.restoreCheckpoint(handle)).rejects.toBeInstanceOf(
      CheckpointHandleInvalidError,
    );
    await expect(mgr.discardCheckpoint(handle)).rejects.toBeInstanceOf(
      CheckpointHandleInvalidError,
    );
  });

  it("each save returns a distinct handle even for the same (slotId, name)", async () => {
    const recorded: RecordedRequest[] = [];
    const mgr = new CheckpointManager({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: makeFetch(recorded),
      resolveSlotId: () => 0,
    });
    const a = await mgr.saveCheckpoint("conv-x", "pre-draft");
    const b = await mgr.saveCheckpoint("conv-x", "pre-draft");
    expect(a.id).not.toBe(b.id);
    expect(a.backendRef?.filename).not.toBe(b.backendRef?.filename);
  });

  it("rejects malformed slotId or checkpoint name", async () => {
    const mgr = new CheckpointManager({
      baseUrl: "http://127.0.0.1:9999",
      fetchImpl: makeFetch([]),
    });
    await expect(mgr.saveCheckpoint("", "pre-draft")).rejects.toThrow(
      /invalid slotId/,
    );
    await expect(
      mgr.saveCheckpoint("conv-1", "../etc/passwd"),
    ).rejects.toThrow(/invalid checkpoint name/);
  });
});

describe("MockCheckpointManager", () => {
  it("records save / restore / discard operations in order", async () => {
    const mock = new MockCheckpointManager();
    const handle = await mock.saveCheckpoint("conv-1", "pre-draft");
    await mock.restoreCheckpoint(handle);
    await mock.discardCheckpoint(handle);
    expect(mock.operations).toEqual([
      { kind: "save", slotId: "conv-1", name: "pre-draft", handleId: 1 },
      { kind: "restore", handleId: 1 },
      { kind: "discard", handleId: 1 },
    ]);
  });

  it("restore replays the snapshot's tokens onto currentTokens", async () => {
    const mock = new MockCheckpointManager(() => ({
      tokens: [10, 11, 12],
      metadata: { partial: "hello wo" },
    }));
    const handle = await mock.saveCheckpoint("conv-1", "pre-draft");
    mock.currentTokens = [99, 99, 99, 99]; // simulate post-pause drafter writes
    await mock.restoreCheckpoint(handle);
    expect(mock.currentTokens).toEqual([10, 11, 12]);
  });

  it("the same handle can be restored more than once (consecutive barge-ins)", async () => {
    let snapshotCallCount = 0;
    const mock = new MockCheckpointManager(() => {
      snapshotCallCount++;
      return { tokens: [1, 2, 3] };
    });
    const handle = await mock.saveCheckpoint("conv-1", "pre-draft");
    expect(snapshotCallCount).toBe(1);
    await mock.restoreCheckpoint(handle);
    await mock.restoreCheckpoint(handle);
    expect(mock.operations.filter((op) => op.kind === "restore")).toHaveLength(
      2,
    );
    // Handle still live.
    expect(mock.liveHandleCount()).toBe(1);
  });

  it("rejects restore/discard for unknown or already-discarded handles", async () => {
    const mock = new MockCheckpointManager();
    const handle = await mock.saveCheckpoint("conv-1", "pre-draft");
    await mock.discardCheckpoint(handle);
    await expect(mock.restoreCheckpoint(handle)).rejects.toBeInstanceOf(
      CheckpointHandleInvalidError,
    );
    await expect(mock.discardCheckpoint(handle)).rejects.toBeInstanceOf(
      CheckpointHandleInvalidError,
    );
  });

  it("defaults to capturing currentTokens at save time when no snapshotSource is provided", async () => {
    const mock = new MockCheckpointManager();
    mock.currentTokens = [7, 8, 9];
    const handle = await mock.saveCheckpoint("conv-1", "pre-draft");
    mock.currentTokens = [1];
    await mock.restoreCheckpoint(handle);
    expect(mock.currentTokens).toEqual([7, 8, 9]);
  });
});

describe("prefillOptimistic", () => {
  it("delegates to the checkpoint manager and returns the same handle", async () => {
    const mock = new MockCheckpointManager(() => ({ tokens: [1, 2, 3] }));
    const result = await prefillOptimistic(
      { slotId: "conv-1", partialText: "hello there", eotProb: 0.7 },
      { checkpointManager: mock },
    );
    expect(result.backend).toBe("slot-save-stub");
    expect(result.eotProb).toBe(0.7);
    expect(result.handle.slotId).toBe("conv-1");
    // The handle should be live and restorable.
    await mock.restoreCheckpoint(result.handle);
    expect(mock.operations.map((o) => o.kind)).toEqual(["save", "restore"]);
  });

  it("rejects empty partialText and out-of-range eotProb", async () => {
    const mock = new MockCheckpointManager();
    await expect(
      prefillOptimistic(
        { slotId: "conv-1", partialText: "  ", eotProb: 0.5 },
        { checkpointManager: mock },
      ),
    ).rejects.toThrow(/partialText/);
    await expect(
      prefillOptimistic(
        { slotId: "conv-1", partialText: "hi", eotProb: 1.5 },
        { checkpointManager: mock },
      ),
    ).rejects.toThrow(/eotProb/);
  });
});
