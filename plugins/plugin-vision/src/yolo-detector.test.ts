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

describe("YOLODetector NMS sorting", () => {
  it("maintains strict total ordering when detection scores contain non-finite values", () => {
    const yolo = new YOLODetector();
    const detections = [
      {
        classId: 0,
        className: "person",
        score: 0.9,
        x: 10,
        y: 10,
        width: 50,
        height: 50,
      },
      {
        classId: 0,
        className: "person",
        score: Number.NaN,
        x: 10,
        y: 10,
        width: 50,
        height: 50,
      },
      {
        classId: 0,
        className: "person",
        score: 0.8,
        x: 100,
        y: 100,
        width: 50,
        height: 50,
      },
    ];
    const nms = (
      yolo as unknown as { nms: (dets: typeof detections) => typeof detections }
    ).nms.bind(yolo);
    const kept = nms(detections);
    expect(kept).toHaveLength(2);
    expect(kept[0]?.score).toBe(0.9);
    expect(kept[1]?.score).toBe(0.8);
  });
});
