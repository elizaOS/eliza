import { describe, expect, it } from "vitest";
import { PersonDetector } from "./person-detector";
import { MediaPipeFaceDetector } from "./face-detector-mediapipe";
import { YOLODetector } from "./yolo-detector";

describe("YOLODetector availability + lifecycle", () => {
  it("static isAvailable returns a typed boolean", async () => {
    const ok = await YOLODetector.isAvailable();
    expect(typeof ok).toBe("boolean");
  });

  it("constructs with default and custom config", () => {
    const yolo = new YOLODetector();
    expect(yolo).toBeInstanceOf(YOLODetector);
    const filtered = new YOLODetector({ classFilter: ["person"], scoreThreshold: 0.5 });
    expect(filtered).toBeInstanceOf(YOLODetector);
  });

  it("init fails fast with a bad URL", async () => {
    const yolo = new YOLODetector({
      modelDir: `/tmp/yolo-test-${Date.now()}`,
      modelUrl: "http://127.0.0.1:1/missing.onnx",
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
    expect(await PersonDetector.isAvailable()).toBe(await YOLODetector.isAvailable());
  });
});

describe("MediaPipeFaceDetector", () => {
  it("constructs and reports availability", async () => {
    const det = new MediaPipeFaceDetector();
    expect(det).toBeInstanceOf(MediaPipeFaceDetector);
    expect(typeof (await MediaPipeFaceDetector.isAvailable())).toBe("boolean");
  });

  it("init fails fast with a bad URL", async () => {
    const det = new MediaPipeFaceDetector({
      modelDir: `/tmp/mp-face-${Date.now()}`,
      modelUrl: "http://127.0.0.1:1/missing.onnx",
    });
    await expect(det.initialize()).rejects.toBeInstanceOf(Error);
  });
});
