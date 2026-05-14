// Integration test: simulate a memory-pressure event on a fake arbiter and
// verify that registered vision sub-services (YOLO + OCR) get released.

import { describe, expect, it, vi } from "vitest";
import { type IModelArbiter, VisionServiceLifecycleManager } from "./lifecycle";

function makeArbiter() {
  let listener: ((ids: string[]) => void) | null = null;
  const acquired = new Map<string, number>();
  const arbiter: IModelArbiter = {
    acquire: vi.fn(async (id: string, bytes: number) => {
      acquired.set(id, bytes);
      return true;
    }),
    release: vi.fn(async (id: string) => {
      acquired.delete(id);
    }),
    onPressure: (cb: (ids: string[]) => void) => {
      listener = cb;
      return () => {
        listener = null;
      };
    },
  };
  return {
    arbiter,
    acquired,
    fire(ids: string[] = []) {
      listener?.(ids);
    },
  };
}

describe("VisionServiceLifecycleManager — arbiter pressure integration", () => {
  it("releases YOLO + RapidOCR when arbiter signals pressure", async () => {
    const { arbiter, fire } = makeArbiter();
    const mgr = new VisionServiceLifecycleManager({
      idleUnloadMs: 60_000,
      watchdogIntervalMs: 1_000_000,
    });
    mgr.attachArbiter(arbiter);

    const yoloUnload = vi.fn();
    const ocrUnload = vi.fn();
    const florenceUnload = vi.fn();

    mgr.register({
      id: "vision:yolo",
      memoryBytes: 60 * 1024 * 1024,
      unload: yoloUnload,
    });
    mgr.register({
      id: "vision:ocr",
      memoryBytes: 80 * 1024 * 1024,
      unload: ocrUnload,
    });
    mgr.register({
      id: "vision:florence2",
      memoryBytes: 200 * 1024 * 1024,
      unload: florenceUnload,
    });

    // Mark Florence2 as recently used so the coldest-first ordering puts YOLO
    // + OCR ahead of it.
    await mgr.touch("vision:florence2");

    // Targeted release: arbiter names exactly YOLO + OCR.
    fire(["vision:yolo", "vision:ocr"]);
    await new Promise((resolve) => setImmediate(resolve));

    expect(yoloUnload).toHaveBeenCalledTimes(1);
    expect(ocrUnload).toHaveBeenCalledTimes(1);
    expect(florenceUnload).not.toHaveBeenCalled();

    const snap = mgr.snapshot();
    expect(snap.find((s) => s.id === "vision:yolo")?.loaded).toBe(false);
    expect(snap.find((s) => s.id === "vision:ocr")?.loaded).toBe(false);
    expect(snap.find((s) => s.id === "vision:florence2")?.loaded).toBe(true);

    await mgr.stop();
  });

  it("works standalone when no arbiter is registered", async () => {
    const mgr = new VisionServiceLifecycleManager({
      idleUnloadMs: 60_000,
      watchdogIntervalMs: 1_000_000,
    });
    // No attachArbiter() call — pure standalone path.
    const unload = vi.fn();
    mgr.register({ id: "vision:yolo", memoryBytes: 50_000_000, unload });
    await mgr.release("vision:yolo");
    expect(unload).toHaveBeenCalledTimes(1);
    await mgr.stop();
  });
});
