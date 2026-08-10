/**
 * Worker-manager readiness tests use shared-buffer metadata without spawning workers.
 */

import { describe, expect, it } from "vitest";
import { VisionWorkerManager } from "./vision-worker-manager";

describe("VisionWorkerManager readiness", () => {
  it("does not treat zero-filled shared memory as a completed frame", () => {
    const manager = new VisionWorkerManager({ ocrEnabled: true });

    expect(manager.getLatestScreenCapture()).toBeNull();
    expect(manager.getReadiness()).toEqual({
      screenCapture: false,
      ocr: false,
    });
  });

  it("becomes ready only after committed screen and OCR results exist", () => {
    const manager = new VisionWorkerManager({ ocrEnabled: true });
    const state = Reflect.get(manager, "screenAtomicState") as Int32Array;
    Atomics.store(state, 2, 1280);
    Atomics.store(state, 3, 720);
    Atomics.store(state, 5, 42);
    Atomics.store(state, 0, 1);

    expect(manager.getReadiness()).toEqual({
      screenCapture: true,
      ocr: false,
    });

    Reflect.set(manager, "latestOCRResult", {
      text: "",
      fullText: "",
      blocks: [],
    });
    expect(manager.getReadiness()).toEqual({
      screenCapture: true,
      ocr: true,
    });
  });
});
