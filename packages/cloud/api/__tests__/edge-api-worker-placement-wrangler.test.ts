/**
 * Pins the placement policy of the mixed stateful edge/API Worker: never
 * Cloudflare Smart Placement, which would move the Worker away from its
 * Durable Objects on inferred traffic; an environment may only pin an
 * explicitly measured region with targeted placement.
 */

import { describe, expect, test } from "bun:test";

type PlacementConfig = { placement?: { mode?: string; region?: string } };
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
      const placement = scope?.placement;
      if (placement === undefined) continue;
      expect(placement.mode, label).toBe("targeted");
      expect(placement.region, label).toMatch(/^[a-z]+:[a-z]+-[a-z]+\d+$/);
    }
  });
});
