/**
 * Detector lifecycle tests for YOLO, person, and MediaPipe face adapters.
 */

import { describe, expect, it } from "vitest";
import { MediaPipeFaceDetector } from "./face-detector-mediapipe";
import { YOLODetector } from "./yolo-detector";

describe("YOLODetector availability + lifecycle", () => {
  it("init fails fast when GGUF weights are missing", async () => {
    const yolo = new YOLODetector({
      weightsPath: `/tmp/yolo-missing-${Date.now()}.gguf`,
    });
    await expect(yolo.initialize()).rejects.toBeInstanceOf(Error);
  });
});

describe("MediaPipeFaceDetector compatibility surface", () => {
  it("reports unavailable without the removed ONNX backend", async () => {
    expect(await MediaPipeFaceDetector.isAvailable()).toBe(false);
  });

  it("initialize() throws a backend-unavailable error", async () => {
    const det = new MediaPipeFaceDetector();
    await expect(det.initialize()).rejects.toBeInstanceOf(Error);
  });
});
