/**
 * Prompt-fusion coverage for injecting detector output into VLM scene descriptions.
 *
 * OCR text, YOLO objects, and recognized faces are added as bounded context while
 * the detection-off path remains byte-for-byte unchanged.
 */

import { describe, expect, it } from "vitest";
import {
  buildSceneDescriptionPrompt,
  type RecognizedFace,
  type VisionContextSnapshot,
} from "./service";
import type { BoundingBox, DetectedObject } from "./types";

function bbox(x: number, y: number): BoundingBox {
  return { x, y, width: 10, height: 10 };
}

function makeObject(
  id: string,
  type: string,
  confidence: number,
): DetectedObject {
  return { id, type, confidence, boundingBox: bbox(0, 0) };
}

const CONTEXT: VisionContextSnapshot = {
  openApps: ["Terminal"],
  focusedWindow: { app: "Terminal", title: "zsh", bbox: null },
  recentActions: [{ action: "click", ts: 1 }],
  currentTaskGoal: "ship #9105",
};

describe("buildSceneDescriptionPrompt — detector fusion", () => {
  it("injects OCR, YOLO objects, and recognized faces into the prompt JSON", () => {
    const objects: DetectedObject[] = [
      makeObject("o1", "laptop", 0.9),
      makeObject("o2", "cup", 0.7),
    ];
    const faces: RecognizedFace[] = [{ label: "Alice", bbox: bbox(5, 5) }];

    const prompt = buildSceneDescriptionPrompt(
      CONTEXT,
      "INVOICE 2026",
      objects,
      faces,
    );
    const payload = JSON.parse(prompt) as {
      detectedText?: string;
      detectedObjects?: Array<{ type: string; confidence: number }>;
      recognizedFaces?: Array<{ label: string }>;
    };

    expect(payload.detectedText).toContain("INVOICE 2026");
    expect(payload.detectedObjects).toBeDefined();
    expect(payload.detectedObjects?.map((o) => o.type)).toEqual([
      "laptop",
      "cup",
    ]);
    expect(payload.recognizedFaces?.map((f) => f.label)).toEqual(["Alice"]);
    // Raw string carries the labels too (what the VLM actually reads).
    expect(prompt).toContain("laptop");
    expect(prompt).toContain("Alice");
  });

  it("omits detectedObjects / recognizedFaces keys when the arrays are empty", () => {
    const prompt = buildSceneDescriptionPrompt(CONTEXT, "some text", [], []);
    const payload = JSON.parse(prompt) as Record<string, unknown>;

    expect(payload.detectedText).toBe("some text");
    expect("detectedObjects" in payload).toBe(false);
    expect("recognizedFaces" in payload).toBe(false);
  });

  it("is byte-identical to the OCR-only call when detectors are omitted", () => {
    const withoutDetectors = buildSceneDescriptionPrompt(CONTEXT, "ocr only");
    const withEmptyDetectors = buildSceneDescriptionPrompt(
      CONTEXT,
      "ocr only",
      [],
      [],
    );
    expect(withEmptyDetectors).toBe(withoutDetectors);
    // OCR injection itself is not regressed.
    expect(JSON.parse(withoutDetectors).detectedText).toBe("ocr only");
  });

  it("caps objects at top-20 by confidence (descending)", () => {
    const objects: DetectedObject[] = Array.from({ length: 25 }, (_, i) =>
      makeObject(`o${i}`, `type-${i}`, i / 100),
    );

    const payload = JSON.parse(
      buildSceneDescriptionPrompt(null, null, objects, []),
    ) as { detectedObjects: Array<{ type: string; confidence: number }> };

    expect(payload.detectedObjects).toHaveLength(20);
    // Highest confidence first; the 5 lowest are dropped.
    expect(payload.detectedObjects[0].type).toBe("type-24");
    expect(payload.detectedObjects.at(-1)?.type).toBe("type-5");
  });

  it("dedupes faces by label and caps at top-10", () => {
    const faces: RecognizedFace[] = [
      { label: "Alice", bbox: bbox(0, 0) },
      { label: "Alice", bbox: bbox(1, 1) },
      ...Array.from({ length: 15 }, (_, i) => ({
        label: `Person-${i}`,
        bbox: bbox(i, i),
      })),
    ];

    const payload = JSON.parse(
      buildSceneDescriptionPrompt(null, null, [], faces),
    ) as { recognizedFaces: Array<{ label: string }> };

    expect(payload.recognizedFaces).toHaveLength(10);
    const labels = payload.recognizedFaces.map((f) => f.label);
    // First Alice kept, duplicate dropped.
    expect(labels.filter((l) => l === "Alice")).toHaveLength(1);
    expect(labels[0]).toBe("Alice");
  });

  it("skips blank face labels", () => {
    const faces: RecognizedFace[] = [
      { label: "   ", bbox: bbox(0, 0) },
      { label: "Bob", bbox: bbox(1, 1) },
    ];

    const payload = JSON.parse(
      buildSceneDescriptionPrompt(null, null, [], faces),
    ) as { recognizedFaces: Array<{ label: string }> };

    expect(payload.recognizedFaces.map((f) => f.label)).toEqual(["Bob"]);
  });
});
