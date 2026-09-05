/** Pins caller-local placement for the mixed stateful edge/API Worker. */

import { describe, expect, test } from "bun:test";

type PlacementConfig = { placement?: { mode?: string } };
type WorkerConfig = PlacementConfig & {
  env?: { staging?: PlacementConfig; production?: PlacementConfig };
};

describe("edge/API Worker placement", () => {
  test("declares no Smart Placement in any environment", async () => {
    const config = Bun.TOML.parse(
      await Bun.file(new URL("../wrangler.toml", import.meta.url)).text(),
    ) as WorkerConfig;
    for (const [label, scope] of [
      ["top level", config],
      ["staging", config.env?.staging],
      ["production", config.env?.production],
    ] as const) {
      expect(scope?.placement, label).toBeUndefined();
    }
  });
});
