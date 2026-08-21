/** Verifies real Cloud processes receive value-free synthetic harness metadata from the manifest-owned stack. */

import { testManifest } from "../../../synthetic-world/src/test-fixture";
import {
  createCloudAgent,
  sendAgentBridgeRequest,
} from "../src/helpers/provisioning";
import { expect, test } from "../src/helpers/test-fixtures";

test.use({
  stackOptions: {
    synthetic: {
      world: testManifest(),
      model: {
        mode: "mock-strict",
        assertConsumption: "per-test",
        fixtures: [
          {
            name: "optional-answer",
            match: { input: "unused optional answer" },
            times: "any",
            response: "ok",
          },
        ],
      },
      agentCount: 1,
      connectors: ["cloud-agent-bridge"],
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
          productionProbe: {
            client: "cloud-sdk",
            method: "GET",
            path: "/v1/items",
            expectedBody: { items: [] },
          },
        },
      ],
      faultScript: [],
    },
  },
});

test("real Cloud processes receive synthetic metadata and reset cleanly", async ({
  stack,
  seededUser,
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
  expect(stack.synthetic?.runtimes).toHaveLength(1);
  expect(stack.synthetic?.runtimeReadiness).toHaveLength(1);
  expect(stack.synthetic?.providerReadiness).toEqual([
    expect.objectContaining({
      providerId: "fixture-provider",
      client: "cloud-sdk",
      path: "/v1/items",
      ledgerRequestCount: 1,
    }),
  ]);

  const agentId = await createCloudAgent(
    { apiUrl: stack.urls.api },
    seededUser.apiKey,
    "synthetic-bridge-readiness",
  );
  const heartbeat = await sendAgentBridgeRequest(
    { apiUrl: stack.urls.api },
    seededUser.apiKey,
    agentId,
    { jsonrpc: "2.0", id: "synthetic-ready", method: "heartbeat" },
  );
  expect(heartbeat.result).toMatchObject({
    ready: true,
    agentId,
    runtime: "shared",
  });

  const queueReceipt = await stack.mocks.controlPlane.processDbBackedJobs(
    stack.urls.pglite,
  );
  expect(queueReceipt.failed, JSON.stringify(queueReceipt.errors)).toBe(0);
  expect(await stack.synthetic?.executionStateHash()).not.toBe("");
});
