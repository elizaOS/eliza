/**
 * Set-of-Marks bridge tests — #9170 M9.
 *
 * The bridge fuses injected icon detections + OCR blocks into numbered marks
 * and registers itself into computeruse's seam. Tested with fakes (no GGUF
 * weights, no OCR engine) so it runs in the default lane.
 */

import { describe, expect, it, vi } from "vitest";
import type { OcrWithCoordsResult } from "./ocr-with-coords.js";
import {
  buildVisionSetOfMarksProvider,
  VISION_SET_OF_MARKS_BRIDGE_NAME,
  wireComputerUseSetOfMarksBridge,
} from "./set-of-marks-provider.js";

function fakeOcr(blocks: OcrWithCoordsResult["blocks"]) {
  return () => ({
    describe: async () => ({ blocks }),
  });
}

describe("buildVisionSetOfMarksProvider", () => {
  it("fuses injected icons + OCR blocks into numbered marks", async () => {
    const provider = buildVisionSetOfMarksProvider({
      detectIcons: async () => [
        {
          boundingBox: { x: 0, y: 0, width: 40, height: 40 },
          type: "button",
          confidence: 0.9,
        },
      ],
      resolveOcr: fakeOcr([
        {
          text: "far text",
          bbox: { x: 300, y: 0, width: 80, height: 18 },
          words: [],
          semantic_position: "upper-right",
        },
      ]) as never,
    });
    const result = await provider.describe({
      displayId: "0",
      sourceX: 0,
      sourceY: 0,
      pngBytes: new Uint8Array([1, 2, 3]),
    });
    expect(result.marks).toHaveLength(2);
    expect(result.marks.map((m) => m.index)).toEqual([1, 2]);
    expect(result.marks.some((m) => m.source === "icon")).toBe(true);
    expect(result.marks.some((m) => m.source === "text")).toBe(true);
    // No overlay unless requested.
    expect(result.overlayPngBase64).toBeUndefined();
  });

  it("degrades to text-only marks when the icon detector is unavailable", async () => {
    const provider = buildVisionSetOfMarksProvider({
      detectIcons: async () => [],
      resolveOcr: fakeOcr([
        {
          text: "hello",
          bbox: { x: 10, y: 10, width: 60, height: 16 },
          words: [],
          semantic_position: "upper-left",
        },
      ]) as never,
    });
    const result = await provider.describe({
      displayId: "0",
      sourceX: 0,
      sourceY: 0,
      pngBytes: new Uint8Array([1]),
    });
    expect(result.marks).toHaveLength(1);
    expect(result.marks[0]?.source).toBe("text");
  });

  it("returns no marks (and no overlay) when both sources are empty", async () => {
    const provider = buildVisionSetOfMarksProvider({
      detectIcons: async () => [],
      resolveOcr: fakeOcr([]) as never,
    });
    const result = await provider.describe({
      displayId: "0",
      sourceX: 0,
      sourceY: 0,
      pngBytes: new Uint8Array([1]),
      renderOverlay: true,
    });
    expect(result.marks).toHaveLength(0);
    expect(result.overlayPngBase64).toBeUndefined();
  });

  it("renders an overlay PNG when requested and marks exist", async () => {
    const sharp = (await import("sharp")).default;
    const png = await sharp({
      create: {
        width: 100,
        height: 80,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .png()
      .toBuffer();
    const provider = buildVisionSetOfMarksProvider({
      detectIcons: async () => [
        { boundingBox: { x: 5, y: 5, width: 30, height: 20 }, confidence: 0.8 },
      ],
      resolveOcr: fakeOcr([]) as never,
    });
    const result = await provider.describe({
      displayId: "0",
      sourceX: 0,
      sourceY: 0,
      pngBytes: new Uint8Array(png),
      renderOverlay: true,
    });
    expect(result.marks).toHaveLength(1);
    expect(typeof result.overlayPngBase64).toBe("string");
    const decoded = Buffer.from(result.overlayPngBase64 ?? "", "base64");
    const meta = await sharp(decoded).metadata();
    expect(meta.width).toBe(100);
  });
});

describe("wireComputerUseSetOfMarksBridge", () => {
  it("registers a provider with the bridge name", () => {
    const register = vi.fn();
    const ok = wireComputerUseSetOfMarksBridge(register, {
      detectIcons: async () => [],
      resolveOcr: fakeOcr([]) as never,
    });
    expect(ok).toBe(true);
    expect(register).toHaveBeenCalledTimes(1);
    const provider = register.mock.calls[0]?.[0] as { name: string };
    expect(provider.name).toBe(VISION_SET_OF_MARKS_BRIDGE_NAME);
  });
});
