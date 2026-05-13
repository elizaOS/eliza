/**
 * Unit tests for `CheckpointPolicy`. The policy is a pure VAD-event →
 * checkpoint-op translator with no I/O of its own — every test injects a
 * stub `GatedCheckpointManager` and asserts on the recorded ops.
 *
 * NB: per the scaffold task envelope, this test must NOT spawn a real
 * llama-server or load a real model. Everything is mocked at the JS layer.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CheckpointHandle,
  GatedCheckpointManager,
  SseDisconnectFn,
} from "../../checkpoint-manager";
import { CheckpointPolicy, checkpointNameFor } from "../checkpoint-policy";

/** Op the stub manager recorded — flat tuple for easy `expect(...).toEqual`. */
type RecordedOp =
  | { kind: "save"; slotId: number; name: string }
  | { kind: "restore"; slotId: number; nameOrHandle: string }
  | { kind: "erase"; slotId: number; nameOrHandle: string }
  | { kind: "cancel"; slotId: number };

interface StubOptions {
  flagOn?: boolean;
  capabilityOn?: boolean;
  saveReturns?: CheckpointHandle | null | "throw";
  restoreReturns?: boolean | "throw";
  eraseThrows?: boolean;
  cancelThrows?: boolean;
}

/**
 * Build a stub `GatedCheckpointManager`. Records every call into `ops`
 * and exposes the registry via `getNamedHandle`. The default behavior is
 * "happy path" — feature flag on, capability on, save returns a handle.
 */
function makeStub(opts: StubOptions = {}): {
  mgr: GatedCheckpointManager;
  ops: RecordedOp[];
  registry: Map<string, CheckpointHandle>;
} {
  const ops: RecordedOp[] = [];
  const registry = new Map<string, CheckpointHandle>();
  const flagOn = opts.flagOn ?? true;
  const capabilityOn = opts.capabilityOn ?? true;

  const makeHandle = (slotId: number, name: string): CheckpointHandle => ({
    slotId: `s${slotId}`,
    name,
    id: ops.length + 1,
    createdAt: new Date(0).toISOString(),
    backendRef: null,
  });

  // Cast to the real type via a structural stub — production callers only
  // touch the methods listed below.
  const stub: Partial<GatedCheckpointManager> = {
    isFeatureFlagOn: () => flagOn,
    isEnabled: () => flagOn && capabilityOn,
    async save(slotId, name) {
      ops.push({ kind: "save", slotId, name });
      if (opts.saveReturns === "throw") {
        throw new Error("save boom");
      }
      if (opts.saveReturns === null) return null;
      const h = opts.saveReturns ?? makeHandle(slotId, name);
      registry.set(name, h);
      return h;
    },
    async restore(slotId, handleOrName) {
      const key =
        typeof handleOrName === "string" ? handleOrName : handleOrName.name;
      ops.push({ kind: "restore", slotId, nameOrHandle: key });
      if (opts.restoreReturns === "throw") {
        throw new Error("restore boom");
      }
      if (opts.restoreReturns === false) return false;
      return registry.has(key);
    },
    async erase(slotId, handleOrName) {
      const key =
        typeof handleOrName === "string" ? handleOrName : handleOrName.name;
      ops.push({ kind: "erase", slotId, nameOrHandle: key });
      registry.delete(key);
      if (opts.eraseThrows) throw new Error("erase boom");
    },
    async cancel(slotId, sseDisconnect: SseDisconnectFn) {
      ops.push({ kind: "cancel", slotId });
      if (opts.cancelThrows) throw new Error("cancel boom");
      if (!flagOn || !capabilityOn) sseDisconnect(slotId);
    },
    getNamedHandle: (name) => registry.get(name) ?? null,
  };

  return { mgr: stub as GatedCheckpointManager, ops, registry };
}

describe("checkpointNameFor", () => {
  it("encodes the turn id as `pre-speculative-T<id>`", () => {
    expect(checkpointNameFor("123")).toBe("pre-speculative-T123");
  });

  it("sanitizes turn ids that contain non-filename chars", () => {
    expect(checkpointNameFor("conv:42/turn-7")).toBe(
      "pre-speculative-Tconv_42_turn-7",
    );
  });
});

describe("CheckpointPolicy — gate ON", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    // Silence the policy's own warn logs — they're not what we're asserting.
    // The logger import resolves to `@elizaos/core`'s logger; spying on
    // `console.warn` covers the underlying transport.
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  it("onSpeechPause issues save with the per-turn name", async () => {
    const { mgr, ops } = makeStub();
    const policy = new CheckpointPolicy({ manager: mgr });
    await policy.onSpeechPause("T1", 3);
    expect(ops).toEqual([
      { kind: "save", slotId: 3, name: "pre-speculative-TT1" },
    ]);
  });

  it("onSpeechResume restores when speculativeFired=true", async () => {
    const { mgr, ops } = makeStub();
    const policy = new CheckpointPolicy({ manager: mgr });
    await policy.onSpeechPause("T2", 5);
    await policy.onSpeechResume("T2", 5, { speculativeFired: true });
    expect(ops).toEqual([
      { kind: "save", slotId: 5, name: "pre-speculative-TT2" },
      {
        kind: "restore",
        slotId: 5,
        nameOrHandle: "pre-speculative-TT2",
      },
    ]);
  });

  it("onSpeechResume no-ops when speculativeFired=false", async () => {
    const { mgr, ops } = makeStub();
    const noopSink = vi.fn();
    const policy = new CheckpointPolicy({
      manager: mgr,
      events: { onNoop: noopSink },
    });
    await policy.onSpeechPause("T3", 1);
    await policy.onSpeechResume("T3", 1, { speculativeFired: false });
    expect(ops).toHaveLength(1); // only the save
    expect(noopSink).toHaveBeenCalledWith("restore", "T3", "no-speculative");
  });

  it("onSpeechResume emits onNoop=registry-miss when manager.restore returns false", async () => {
    const { mgr, ops } = makeStub({ restoreReturns: false });
    const noopSink = vi.fn();
    const policy = new CheckpointPolicy({
      manager: mgr,
      events: { onNoop: noopSink },
    });
    await policy.onSpeechResume("T4", 2, { speculativeFired: true });
    expect(ops).toEqual([
      {
        kind: "restore",
        slotId: 2,
        nameOrHandle: "pre-speculative-TT4",
      },
    ]);
    expect(noopSink).toHaveBeenCalledWith("restore", "T4", "registry-miss");
  });

  it("onSpeechEndCommit erases the per-turn checkpoint", async () => {
    const { mgr, ops } = makeStub();
    const policy = new CheckpointPolicy({ manager: mgr });
    await policy.onSpeechPause("T5", 4);
    await policy.onSpeechEndCommit("T5", 4);
    expect(ops.at(-1)).toEqual({
      kind: "erase",
      slotId: 4,
      nameOrHandle: "pre-speculative-TT5",
    });
  });

  it("onHardStop with existing C1 restores then erases (no cancel)", async () => {
    const { mgr, ops } = makeStub();
    const sse = vi.fn();
    const policy = new CheckpointPolicy({ manager: mgr });
    await policy.onSpeechPause("T6", 7);
    await policy.onHardStop("T6", 7, sse);
    const kinds = ops.map((o) => o.kind);
    expect(kinds).toEqual(["save", "restore", "erase"]);
    expect(sse).not.toHaveBeenCalled();
  });

  it("onHardStop with no C1 falls through to manager.cancel", async () => {
    const { mgr, ops } = makeStub();
    const sse = vi.fn();
    const policy = new CheckpointPolicy({ manager: mgr });
    await policy.onHardStop("T7", 9, sse);
    expect(ops).toEqual([{ kind: "cancel", slotId: 9 }]);
  });

  it("emits onError when manager.save throws", async () => {
    const { mgr } = makeStub({ saveReturns: "throw" });
    const onError = vi.fn();
    const policy = new CheckpointPolicy({ manager: mgr, events: { onError } });
    await policy.onSpeechPause("T8", 1);
    expect(onError).toHaveBeenCalledWith("save", expect.any(Error), "T8");
  });

  it("emits onError when manager.restore throws but policy does not rethrow", async () => {
    const { mgr } = makeStub({ restoreReturns: "throw" });
    const onError = vi.fn();
    const policy = new CheckpointPolicy({ manager: mgr, events: { onError } });
    await expect(
      policy.onSpeechResume("T9", 2, { speculativeFired: true }),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith("restore", expect.any(Error), "T9");
  });

  it("emits onSaved with the returned handle", async () => {
    const { mgr } = makeStub();
    const onSaved = vi.fn();
    const policy = new CheckpointPolicy({ manager: mgr, events: { onSaved } });
    await policy.onSpeechPause("T10", 1);
    expect(onSaved).toHaveBeenCalledWith(
      "T10",
      expect.objectContaining({ name: "pre-speculative-TT10" }),
    );
  });
});

describe("CheckpointPolicy — gate OFF (no-op path)", () => {
  it("onSpeechPause does not call manager.save", async () => {
    const { mgr, ops } = makeStub({ flagOn: false });
    const policy = new CheckpointPolicy({ manager: mgr });
    await policy.onSpeechPause("T1", 3);
    expect(ops).toHaveLength(0);
  });

  it("onSpeechResume does not call manager.restore", async () => {
    const { mgr, ops } = makeStub({ flagOn: false });
    const policy = new CheckpointPolicy({ manager: mgr });
    await policy.onSpeechResume("T2", 3, { speculativeFired: true });
    expect(ops).toHaveLength(0);
  });

  it("onSpeechEndCommit does not call manager.erase", async () => {
    const { mgr, ops } = makeStub({ flagOn: false });
    const policy = new CheckpointPolicy({ manager: mgr });
    await policy.onSpeechEndCommit("T3", 3);
    expect(ops).toHaveLength(0);
  });

  it("onHardStop invokes SSE-disconnect callback synchronously", async () => {
    const { mgr, ops } = makeStub({ flagOn: false });
    const sse = vi.fn();
    const policy = new CheckpointPolicy({ manager: mgr });
    await policy.onHardStop("T4", 11, sse);
    expect(sse).toHaveBeenCalledWith(11);
    expect(ops).toHaveLength(0);
  });
});
