/** Exercises the manifest-owned Cloud synthetic stack, canonical reset, strict model wire, and teardown. */

import { afterEach, describe, expect, test } from "bun:test";
import { testManifest } from "../../../../synthetic-world/src/test-fixture";
import { startCloudStack } from "./stack";
import {
  type RunningSyntheticStack,
  startSyntheticStack,
} from "./synthetic-stack";

const running: RunningSyntheticStack[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((stack) => stack.stop()));
});

describe("Cloud synthetic stack manifest", () => {
  test("resets model, provider, ledger, state, and generations as one attempt", async () => {
    const stack = await startSyntheticStack(
      {
        world: testManifest(),
        model: {
          mode: "mock-strict",
          assertConsumption: "per-test",
          fixtures: [
            {
              name: "answer",
              match: { input: "synthetic question" },
              response: "synthetic answer",
            },
          ],
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
                response: { status: 200, body: { items: [{ id: "item-1" }] } },
              },
            ],
          },
        ],
        faultScript: [],
      },
      "attempt-one",
    );
    running.push(stack);
    const model = stack.model;
    if (!model) throw new Error("strict model sidecar did not boot");
    const provider = stack.providers.get("fixture-provider");
    if (!provider) throw new Error("fixture provider did not boot");
    const initialProvider = await provider.control.snapshot();
    const dataOnlyHash = stack.world.stateHash;
    await stack.world.clock.advanceBy(1_000);
    expect(stack.world.stateHash).toBe(dataOnlyHash);
    expect(await stack.executionStateHash()).not.toBe(
      stack.initialExecutionStateHash,
    );
    await stack.reset();

    const modelResponse = await fetch(`${model.url}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "fixture-model",
        messages: [{ role: "user", content: "synthetic question" }],
      }),
    });
    expect(modelResponse.status).toBe(200);
    expect(model.requestCount()).toBe(1);
    expect(await stack.executionStateHash()).not.toBe(
      stack.initialExecutionStateHash,
    );
    expect((await fetch(`${provider.url}/v1/items`)).status).toBe(200);
    stack.world.updateData((data) => {
      data.tasks[0].status = "completed";
    });
    expect(stack.world.stateHash).not.toBe(stack.initialStateHash);

    await stack.reset();

    expect(stack.world.stateHash).toBe(stack.initialStateHash);
    expect(stack.world.ledger.all()).toEqual([]);
    expect(model.requestCount()).toBe(0);
    const resetProvider = await provider.control.snapshot();
    expect(await stack.executionStateHash()).toBe(
      stack.initialExecutionStateHash,
    );
    expect(resetProvider.generation).toBeGreaterThan(
      initialProvider.generation,
    );
  }, 30_000);

  test("fails authoring before boot when strict model fixtures are absent", async () => {
    await expect(
      startSyntheticStack(
        {
          world: testManifest(),
          model: {
            mode: "mock-strict",
            assertConsumption: "per-test",
            fixtures: [],
          },
          agentCount: 0,
          connectors: [],
          backgroundWorkers: ["cloud-api", "container-control-plane"],
          frontendTargets: [],
          providers: [],
          faultScript: [],
        },
        "missing-model-fixtures",
      ),
    ).rejects.toThrow("requires strict model fixtures");
  });

  test("transactionally releases parent env ownership and resources after startup failure", async () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const signalListeners = process.listenerCount("SIGTERM");
    const invalid = {
      world: testManifest(),
      model: {
        mode: "mock-strict" as const,
        assertConsumption: "per-test" as const,
        fixtures: [],
      },
      agentCount: 0,
      connectors: [],
      backgroundWorkers: [
        "cloud-api" as const,
        "container-control-plane" as const,
      ],
      frontendTargets: [],
      providers: [],
      faultScript: [],
    };
    await expect(startCloudStack({ synthetic: invalid })).rejects.toThrow(
      "requires strict model fixtures",
    );
    await expect(startCloudStack({ synthetic: invalid })).rejects.toThrow(
      "requires strict model fixtures",
    );
    expect(process.env.DATABASE_URL).toBe(previousDatabaseUrl);
    expect(process.listenerCount("SIGTERM")).toBe(signalListeners);
  });
});
