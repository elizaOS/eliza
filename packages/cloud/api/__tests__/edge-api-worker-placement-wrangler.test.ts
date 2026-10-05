/** Pins caller-local placement for the mixed stateful edge/API Worker. */

import { describe, expect, test } from "bun:test";

type PlacementConfig = { placement?: { mode?: string; region?: string } };
type WorkerConfig = PlacementConfig & {
  env?: { staging?: PlacementConfig; production?: PlacementConfig };
};

describe("edge/API Worker placement", () => {
  test("keeps the measured target explicit without enabling Smart Placement", async () => {
    const config = Bun.TOML.parse(
      await Bun.file(new URL("../wrangler.toml", import.meta.url)).text(),
    ) as WorkerConfig;
    expect(config.placement).toBeUndefined();
    for (const [label, scope] of [
      ["staging", config.env?.staging],
      ["production", config.env?.production],
    ] as const) {
      expect(scope?.placement, label).toEqual({
        mode: "targeted",
        region: "gcp:us-west2",
      });
    }
  });
});
