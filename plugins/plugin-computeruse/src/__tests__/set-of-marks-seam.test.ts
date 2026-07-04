/**
 * Set-of-Marks provider seam (#9170 M9).
 *
 * detect_elements consumes whatever Set-of-Marks provider plugin-vision
 * registers here. The seam itself is a last-call-wins registration slot — same
 * contract as the CoordOcrProvider seam — so this guards register/get/unregister
 * and the shape the consumer relies on.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  getSetOfMarksProvider,
  registerSetOfMarksProvider,
  type SetOfMarksProvider,
} from "../mobile/ocr-provider.js";

function fakeProvider(name = "fake-som"): SetOfMarksProvider {
  return {
    name,
    async describe(input) {
      return {
        marks: [
          {
            index: 1,
            bbox: [input.sourceX + 10, input.sourceY + 10, 40, 40],
            center: [input.sourceX + 30, input.sourceY + 30],
            source: "icon",
            label: "button",
            score: 0.9,
          },
        ],
        overlayPngBase64: input.renderOverlay ? "ZmFrZQ==" : undefined,
      };
    },
  };
}

describe("Set-of-Marks provider seam", () => {
  afterEach(() => registerSetOfMarksProvider(null));

  it("is empty until a provider registers", () => {
    registerSetOfMarksProvider(null);
    expect(getSetOfMarksProvider()).toBeNull();
  });

  it("returns the registered provider (last-call-wins)", () => {
    registerSetOfMarksProvider(fakeProvider("first"));
    registerSetOfMarksProvider(fakeProvider("second"));
    expect(getSetOfMarksProvider()?.name).toBe("second");
  });

  it("unregisters with null", () => {
    registerSetOfMarksProvider(fakeProvider());
    expect(getSetOfMarksProvider()).not.toBeNull();
    registerSetOfMarksProvider(null);
    expect(getSetOfMarksProvider()).toBeNull();
  });

  it("describe yields numbered marks + a center click target", async () => {
    registerSetOfMarksProvider(fakeProvider());
    const provider = getSetOfMarksProvider();
    const result = await provider?.describe({
      displayId: "0",
      sourceX: 100,
      sourceY: 200,
      pngBytes: new Uint8Array([1]),
      renderOverlay: true,
    });
    expect(result.marks[0]?.index).toBe(1);
    expect(result.marks[0]?.center).toEqual([130, 230]);
    expect(result.overlayPngBase64).toBe("ZmFrZQ==");
  });
});
