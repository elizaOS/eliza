import { describe, expect, it } from "vitest";
import { MediaPipeFaceDetector } from "./face-detector-mediapipe";
import { PersonDetector } from "./person-detector";
import { YOLODetector } from "./yolo-detector";

describe("YOLODetector availability + lifecycle", () => {
  it("static isAvailable returns a typed boolean", async () => {
    const ok = await YOLODetector.isAvailable();
    expect(typeof ok).toBe("boolean");
  });

  it("constructs with default and custom config", () => {
    const yolo = new YOLODetector();
    expect(yolo).toBeInstanceOf(YOLODetector);
    const filtered = new YOLODetector({
      classFilter: ["person"],
      scoreThreshold: 0.5,
    });
    expect(filtered).toBeInstanceOf(YOLODetector);
  });

  it("init fails fast when GGUF weights are missing", async () => {
    const yolo = new YOLODetector({
      weightsPath: `/tmp/yolo-missing-${Date.now()}.gguf`,
    });
    await expect(yolo.initialize()).rejects.toBeInstanceOf(Error);
  });
});

describe("PersonDetector", () => {
  it("delegates to YOLODetector with class filter", () => {
    const detector = new PersonDetector();
    expect(detector).toBeInstanceOf(PersonDetector);
  });

  it("availability mirrors YOLODetector", async () => {
    expect(await PersonDetector.isAvailable()).toBe(
      await YOLODetector.isAvailable(),
    );
  });
});

describe("MediaPipeFaceDetector (deprecated stub)", () => {
  it("constructs and reports unavailable until RetinaFace ggml port lands", async () => {
    const det = new MediaPipeFaceDetector();
    expect(det).toBeInstanceOf(MediaPipeFaceDetector);
    expect(await MediaPipeFaceDetector.isAvailable()).toBe(false);
  });

  it("initialize() throws a migration-in-progress error", async () => {
    const det = new MediaPipeFaceDetector();
    await expect(det.initialize()).rejects.toBeInstanceOf(Error);
  });
});
