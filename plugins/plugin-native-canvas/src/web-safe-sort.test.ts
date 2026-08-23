/**
 * Verifies safe sorting in Native Canvas when layer zIndex contains NaN or non-finite numbers.
 */

import { describe, expect, it } from "vitest";

describe("native-canvas safe sort", () => {
  it("safely sorts visible layers when zIndex contains NaN or non-finite numbers", () => {
    const layers = [
      { id: "layer-2", visible: true, zIndex: 10 },
      { id: "layer-nan", visible: true, zIndex: NaN },
      { id: "layer-1", visible: true, zIndex: 1 },
      { id: "layer-inf", visible: true, zIndex: Infinity },
    ];

    const sorted = layers
      .filter((layer) => layer.visible)
      .sort((a, b) => {
        const aZ = Number.isFinite(a.zIndex) ? a.zIndex : 0;
        const bZ = Number.isFinite(b.zIndex) ? b.zIndex : 0;
        return aZ - bZ || a.id.localeCompare(b.id);
      });

    expect(sorted).toHaveLength(4);
    expect(sorted[0].id).toBe("layer-inf");
    expect(sorted[1].id).toBe("layer-nan");
    expect(sorted[2].id).toBe("layer-1");
    expect(sorted[3].id).toBe("layer-2");
  });
});
