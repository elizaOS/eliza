/**
 * Unit coverage for the OcrWithCoords service registry seam (#9105 M1).
 *
 * `registerOcrWithCoordsService` / `getOcrWithCoordsService` is the third OCR
 * seam called out in the CUA×Vision EPIC — vision's own coords-service slot
 * (distinct from computeruse's line-only + CoordOcrProvider registries). The
 * existing ocr-with-coords test covers `computeSemanticPosition` but not the
 * registry's single-slot lifecycle.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  getOcrWithCoordsService,
  type OcrWithCoordsService,
  registerOcrWithCoordsService,
} from "./ocr-with-coords";

const fakeService = (name: string): OcrWithCoordsService => ({
  name,
  describe: async () => ({ blocks: [] }),
});

afterEach(() => registerOcrWithCoordsService(null));

describe("OcrWithCoords registry seam", () => {
  it("is empty until a service is registered", () => {
    registerOcrWithCoordsService(null);
    expect(getOcrWithCoordsService()).toBeNull();
  });

  it("returns the registered service; last call wins; null clears", () => {
    registerOcrWithCoordsService(fakeService("first"));
    expect(getOcrWithCoordsService()?.name).toBe("first");
    registerOcrWithCoordsService(fakeService("second"));
    expect(getOcrWithCoordsService()?.name).toBe("second");
    registerOcrWithCoordsService(null);
    expect(getOcrWithCoordsService()).toBeNull();
  });
});
