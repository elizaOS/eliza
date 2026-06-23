/**
 * Unit tests for the plugin-vision -> plugin-computeruse OCR bridge (M1).
 *
 * Verifies the bridge delegates to whatever vision OcrWithCoordsService is
 * registered, degrades to empty blocks when none is, and that
 * wireComputerUseOcrBridge registers a correctly-named bridge into a fake
 * computeruse register function — all without a real plugin-computeruse.
 */

import { describe, expect, it, vi } from "vitest";
import {
  buildVisionCoordOcrBridge,
  type CoordOcrProviderLike,
  VISION_COORD_OCR_BRIDGE_NAME,
  wireComputerUseOcrBridge,
} from "./computeruse-ocr-bridge.js";
import type {
  OcrWithCoordsResult,
  OcrWithCoordsService,
} from "./ocr-with-coords.js";

function fakeService(): OcrWithCoordsService {
  return {
    name: "fake-vision-ocr",
    async describe(input): Promise<OcrWithCoordsResult> {
      return {
        blocks: [
          {
            text: "Hello",
            bbox: {
              x: input.sourceX + 5,
              y: input.sourceY + 6,
              width: 30,
              height: 12,
            },
            words: [],
            semantic_position: "upper-left",
          },
        ],
      };
    },
  };
}

const INPUT = {
  displayId: "0",
  sourceX: 100,
  sourceY: 200,
  pngBytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
};

describe("computeruse-ocr-bridge", () => {
  it("delegates describe() to the resolved vision service", async () => {
    const bridge = buildVisionCoordOcrBridge(() => fakeService());
    expect(bridge.name).toBe(VISION_COORD_OCR_BRIDGE_NAME);
    const result = await bridge.describe(INPUT);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toMatchObject({
      text: "Hello",
      bbox: { x: 105, y: 206, width: 30, height: 12 },
    });
  });

  it("returns empty blocks (never throws) when no service is registered", async () => {
    const bridge = buildVisionCoordOcrBridge(() => null);
    await expect(bridge.describe(INPUT)).resolves.toEqual({ blocks: [] });
  });

  it("resolves the service lazily per call (late registration is picked up)", async () => {
    let svc: OcrWithCoordsService | null = null;
    const bridge = buildVisionCoordOcrBridge(() => svc);
    expect((await bridge.describe(INPUT)).blocks).toEqual([]);
    svc = fakeService();
    expect((await bridge.describe(INPUT)).blocks).toHaveLength(1);
  });

  it("wireComputerUseOcrBridge registers a named bridge via the injected register fn", () => {
    let registered: CoordOcrProviderLike | null = null;
    const register = vi.fn((p: CoordOcrProviderLike | null) => {
      registered = p;
    });
    const ok = wireComputerUseOcrBridge(register, () => fakeService());
    expect(ok).toBe(true);
    expect(register).toHaveBeenCalledTimes(1);
    expect(registered).not.toBeNull();
    expect((registered as unknown as CoordOcrProviderLike).name).toBe(
      VISION_COORD_OCR_BRIDGE_NAME,
    );
  });
});
