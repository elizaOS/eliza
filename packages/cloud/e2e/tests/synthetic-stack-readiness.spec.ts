/** Boots the real Cloud Worker and background control plane against one manifest-owned synthetic world. */

import { testManifest } from "../../../synthetic-world/src/test-fixture";
import { expect, test } from "../src/helpers/test-fixtures";

test.use({
  stackOptions: {
    synthetic: {
      world: testManifest(),
      model: {
        mode: "mock-strict",
        assertConsumption: "per-test",
        fixtures: [{ name: "optional-answer", times: "any", response: "ok" }],
      },
      agentCount: 0,
      connectors: [],
      backgroundWorkers: ["cloud-api", "container-control-plane"],
      frontendTargets: [],
      providers: [
        {
          id: "fixture-provider",
          baseUrlEnv: "FIXTURE_PROVIDER_BASE_URL",
          fixtures: [
            {
              id: "items",
              method: "GET",
              path: "/v1/items",
              response: { status: 200, body: { items: [] } },
            },
          ],
        },
      ],
      faultScript: [],
    },
  },
});

test("real Cloud processes acknowledge the synthetic bootstrap and reset cleanly", async ({
  stack,
  syntheticAttempt: _syntheticAttempt,
}) => {
  const expectedBindings = ["FIXTURE_PROVIDER_BASE_URL"];
  const apiHealth = await fetch(`${stack.urls.api}/api/health`);
  expect(await apiHealth.json()).toMatchObject({
    status: "ok",
    syntheticWorld: {
      providerBindings: expectedBindings,
    },
  });
  const controlHealth = await fetch(`${stack.urls.controlPlane}/health`);
  expect(await controlHealth.json()).toMatchObject({
    success: true,
    syntheticWorld: {
      providerBindings: expectedBindings,
    },
  });
  expect(stack.synthetic).toBeDefined();
  expect(await stack.synthetic?.executionStateHash()).not.toBe("");
});
