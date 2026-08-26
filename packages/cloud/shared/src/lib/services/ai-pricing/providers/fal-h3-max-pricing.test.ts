/** Verifies the external MiniMax H3 Max pricing text maps to billable resolution rows. */

import { expect, mock, test } from "bun:test";
import { getSupportedVideoModelDefinition } from "../../ai-pricing-definitions";

mock.module("../../../../db/repositories/ai-pricing", () => ({
  aiPricingRepository: {
    listActiveEntries: async () => [],
  },
}));

const { parseFalPricingEntries } = await import("./fal");

test("parses MiniMax H3 Max per-second prices by resolution", () => {
  const model = getSupportedVideoModelDefinition("minimax/h3-max/image-to-video");
  expect(model).toBeDefined();

  const entries = parseFalPricingEntries(
    model!,
    "Video costs $0.025 per second at 480p, $0.04 per second at 768p.",
  );

  expect(entries).toHaveLength(2);
  expect(entries).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        model: "minimax/h3-max/image-to-video",
        unit: "second",
        unitPrice: 0.025,
        dimensions: { resolution: "480P" },
      }),
      expect.objectContaining({
        model: "minimax/h3-max/image-to-video",
        unit: "second",
        unitPrice: 0.04,
        dimensions: { resolution: "768P" },
      }),
    ]),
  );
});
