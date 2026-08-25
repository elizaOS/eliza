import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PersonDetector } from "./person-detector";
import { __yoloInstances, YOLODetector } from "./yolo-detector";

const BOX = { x: 10, y: 20, width: 30, height: 40 };

function freshDetector(
  config?: Parameters<typeof PersonDetector>[0],
): PersonDetector {
  __yoloInstances.length = 0;
  return new PersonDetector(config);
}

describe("PersonDetector", () => {
  let initSpy: ReturnType<typeof vi.spyOn>;
  let detectSpy: ReturnType<typeof vi.spyOn>;
  let disposeSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    initSpy = vi
      .spyOn(YOLODetector.prototype, "initialize")
      .mockResolvedValue();
    detectSpy = vi
      .spyOn(YOLODetector.prototype, "detect")
      .mockResolvedValue([{ confidence: 0.92, boundingBox: BOX }]);
    disposeSpy = vi
      .spyOn(YOLODetector.prototype, "dispose")
      .mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    __yoloInstances.length = 0;
  });

  it("forwards a person-only class filter to the YOLO detector", () => {
    freshDetector();
    expect(__yoloInstances[0].config.classFilter).toEqual(["person"]);
  });

  it("defaults the score threshold to 0.4", () => {
    freshDetector();
    expect(__yoloInstances[0].config.scoreThreshold).toBe(0.4);
  });

  it("honors an explicit score threshold", () => {
    freshDetector({ scoreThreshold: 0.7 });
    expect(__yoloInstances[0].config.scoreThreshold).toBe(0.7);
  });

  it("starts uninitialized and flips after initialize()", async () => {
    const detector = freshDetector();
    expect(detector.isInitialized()).toBe(false);
    await detector.initialize();
    expect(detector.isInitialized()).toBe(true);
  });

  it("initializes exactly once when called repeatedly", async () => {
    const detector = freshDetector();
    await detector.initialize();
    await detector.initialize();
    expect(initSpy).toHaveBeenCalledTimes(1);
  });

  it("lazily initializes on the first detect() call", async () => {
    const detector = freshDetector();
    expect(detector.isInitialized()).toBe(false);
    await detector.detect(Buffer.from("frame"));
    expect(initSpy).toHaveBeenCalledTimes(1);
    expect(detector.isInitialized()).toBe(true);
  });

  it("maps YOLO objects to PersonInfo records with unknown pose/facing", async () => {
    const detector = freshDetector();
    const people = await detector.detect(Buffer.from("frame"));
    expect(people).toHaveLength(1);
    expect(people[0].confidence).toBe(0.92);
    expect(people[0].boundingBox).toBe(BOX);
    expect(people[0].pose).toBe("unknown");
    expect(people[0].facing).toBe("unknown");
    expect(people[0].id).toMatch(/^person-\d+-\d+$/);
  });

  it("assigns unique ids per detection in a single frame", async () => {
    detectSpy.mockResolvedValue([
      { confidence: 0.9, boundingBox: BOX },
      { confidence: 0.8, boundingBox: BOX },
    ]);
    const detector = freshDetector();
    const people = await detector.detect(Buffer.from("frame"));
    expect(people.map((p) => p.id)).toHaveLength(2);
    expect(new Set(people.map((p) => p.id)).size).toBe(2);
  });

  it("dispose tears down the YOLO detector and resets initialization", async () => {
    const detector = freshDetector();
    await detector.initialize();
    await detector.dispose();
    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect(detector.isInitialized()).toBe(false);
  });

  it("re-initializes after dispose on the next detect()", async () => {
    const detector = freshDetector();
    await detector.detect(Buffer.from("frame"));
    await detector.dispose();
    await detector.detect(Buffer.from("frame"));
    expect(initSpy).toHaveBeenCalledTimes(2);
  });

  it("delegates availability to the YOLO detector backend", async () => {
    const availSpy = vi
      .spyOn(YOLODetector, "isAvailable")
      .mockResolvedValue(false);
    await expect(PersonDetector.isAvailable()).resolves.toBe(false);
    expect(availSpy).toHaveBeenCalledTimes(1);
  });
});
