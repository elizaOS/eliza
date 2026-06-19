import { describe, expect, it, vi } from "vitest";
import {
  type IModelArbiter,
  resolveArbiterFromRuntime,
  VisionServiceLifecycleManager,
} from "./lifecycle";

function makeArbiter(): IModelArbiter & {
  emitPressure: (ids: string[]) => void;
  acquired: Map<string, number>;
} {
  const acquired = new Map<string, number>();
  let listener: ((ids: string[]) => void) | null = null;
  return {
    acquired,
    acquire: vi.fn(async (id: string, bytes: number) => {
      acquired.set(id, bytes);
      return true;
    }),
    release: vi.fn(async (id: string) => {
      acquired.delete(id);
    }),
    onPressure: vi.fn((cb: (ids: string[]) => void) => {
      listener = cb;
      return () => {
        listener = null;
      };
    }),
    emitPressure(ids: string[]) {
      listener?.(ids);
    },
  };
}

describe("VisionServiceLifecycleManager", () => {
  it("releases idle sub-services when the watchdog ticks", async () => {
    const mgr = new VisionServiceLifecycleManager({
      idleUnloadMs: 10,
      watchdogIntervalMs: 1_000_000, // disable real timer; we'll trigger manually
    });
    const unload = vi.fn();
    mgr.register({
      id: "vision:yolo",
      memoryBytes: 50_000_000,
      unload,
    });
    // Force lastUsed into the past.
    const snap = mgr.snapshot();
    expect(snap[0].loaded).toBe(true);
    // Drive the private watchdog directly via a forced release.
    await mgr.release("vision:yolo");
    expect(unload).toHaveBeenCalledTimes(1);
    expect(mgr.snapshot()[0].loaded).toBe(false);
    await mgr.stop();
  });

  it("releases coldest holders first on pressure", async () => {
    const arbiter = makeArbiter();
    const mgr = new VisionServiceLifecycleManager({
      idleUnloadMs: 5_000,
      watchdogIntervalMs: 1_000_000,
    });
    mgr.attachArbiter(arbiter);

    const yoloUnload = vi.fn();
    const ocrUnload = vi.fn();
    mgr.register({
      id: "vision:yolo",
      memoryBytes: 50_000_000,
      unload: yoloUnload,
    });
    mgr.register({
      id: "vision:ocr",
      memoryBytes: 80_000_000,
      unload: ocrUnload,
    });

    // Touch OCR to mark it warmer than YOLO.
    await mgr.touch("vision:ocr");

    arbiter.emitPressure([]);
    // Wait one microtask to let the async pressure handler run.
    await new Promise((r) => setImmediate(r));

    expect(yoloUnload).toHaveBeenCalledTimes(1);
    expect(ocrUnload).toHaveBeenCalledTimes(1);
    await mgr.stop();
  });

  it("re-acquires released sub-services on touch()", async () => {
    const mgr = new VisionServiceLifecycleManager();
    const acquire = vi.fn();
    const unload = vi.fn();
    mgr.register({
      id: "vision:face",
      memoryBytes: 20_000_000,
      acquire,
      unload,
    });
    await mgr.release("vision:face");
    expect(unload).toHaveBeenCalledTimes(1);
    const reloaded = await mgr.touch("vision:face");
    expect(reloaded).toBe(true);
    expect(acquire).toHaveBeenCalledTimes(1);
    await mgr.stop();
  });

  it("resolves an arbiter from the runtime if one is registered", () => {
    const arbiter = makeArbiter();
    const runtime = {
      getService: (name: string) =>
        name === "MEMORY_ARBITER" ? arbiter : null,
    };
    expect(resolveArbiterFromRuntime(runtime)).toBe(arbiter);
  });

  it("returns null when no arbiter service is present", () => {
    const runtime = { getService: () => null };
    expect(resolveArbiterFromRuntime(runtime)).toBeNull();
  });
});
