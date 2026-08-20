/** Exercises the canonical mock control plane while a real Cloud SDK client uses provider routes. */

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CloudApiClient } from "@elizaos/cloud-sdk";
import {
  bootInProcessWorld,
  parseWorldManifest,
  SYNTHETIC_WORLD_SCHEMA_VERSION,
  type SyntheticWorld,
} from "@elizaos/synthetic-world";
import {
  type RunningFakeProvider,
  startFakeProvider,
} from "../../src/provider-contract";

const running: RunningFakeProvider[] = [];
const worlds: SyntheticWorld[] = [];

afterEach(async () => {
  await Promise.all(running.splice(0).map((provider) => provider.stop()));
  for (const world of worlds.splice(0)) world.teardown();
});

function createWorld(name: string): SyntheticWorld {
  const world = bootInProcessWorld(
    parseWorldManifest({
      schemaVersion: SYNTHETIC_WORLD_SCHEMA_VERSION,
      worldId: `provider-${name}`,
      seed: `provider-${name}-v1`,
      clock: { epoch: "2030-01-01T00:00:00.000Z", timezone: "UTC" },
      data: {},
    }),
    { namespace: `provider:${name}` },
  );
  worlds.push(world);
  return world;
}

async function startControlledProvider(): Promise<RunningFakeProvider> {
  const provider = await startFakeProvider({
    accounts: [
      {
        accountId: "acct-control",
        tenantId: "org-control",
        capabilities: ["items.read"],
        apiCredential: "control-client-secret",
      },
    ],
    fixtures: [
      {
        id: "items",
        method: "GET",
        path: "/api/v1/items",
        action: {
          operation: "items.list",
          capabilityId: "items.read",
          effect: "read",
          riskLevel: "R0",
          decision: "allow",
          confirmation: { state: "not_required" },
        },
        response: { status: 200, body: { items: [{ id: "item-1" }] } },
      },
    ],
  });
  running.push(provider);
  return provider;
}

describe("provider mock control contract", () => {
  test("seeds, faults, inspects, and resets without replacing the production client", async () => {
    const provider = await startControlledProvider();
    const client = new CloudApiClient(
      `${provider.url}/api/v1`,
      "control-client-secret",
    );

    expect(
      await client.get<{ items: Array<{ id: string }> }>("/items"),
    ).toEqual({
      items: [{ id: "item-1" }],
    });
    const first = await provider.control.snapshot();
    expect(first).toMatchObject({
      schemaVersion: 1,
      providerId: "generic-provider-contract",
      generation: 1,
      certification: "mock-only-not-provider-qualified",
      state: {
        fixtureIds: ["items"],
        ledger: { requests: [{ method: "GET", path: "/api/v1/items" }] },
      },
    });

    const faulted = await provider.control.fault(
      "GET",
      "/api/v1/items",
      {
        type: "status",
        status: 429,
        headers: { "retry-after": "2" },
        body: { error: { code: "rate_limited" } },
      },
      { expectedGeneration: first.generation },
    );
    expect(faulted.generation).toBe(2);
    await expect(client.get("/items")).rejects.toMatchObject({
      statusCode: 429,
    });

    const seeded = await provider.control.seed(
      [
        {
          id: "empty",
          method: "GET",
          path: "/api/v1/empty",
          response: { status: 200, body: { items: [] } },
        },
      ],
      { expectedGeneration: faulted.generation },
    );
    expect(seeded.state.fixtureIds).toEqual(["empty", "items"]);
    expect(await client.get<{ items: unknown[] }>("/empty")).toEqual({
      items: [],
    });

    const reset = await provider.control.reset({
      expectedGeneration: seeded.generation,
    });
    expect(reset.state).toMatchObject({
      fixtureIds: ["items"],
      pendingFaults: [],
      ledger: { requests: [], receipts: [], effects: [] },
    });
    expect(reset.controlLedger).toEqual([]);
  });

  test("authenticates control calls and resolves concurrent mutations by generation", async () => {
    const provider = await startControlledProvider();
    expect((await fetch(`${provider.controlUrl}/state`)).status).toBe(404);
    const formerlyDerivableToken = `control_${createHash("sha256")
      .update("eliza-provider-contract-v1:provider-mock-control")
      .digest("base64url")}`;
    expect(
      (
        await fetch(`${provider.controlUrl}/state`, {
          headers: {
            "x-eliza-mock-control-token": formerlyDerivableToken,
          },
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${provider.controlUrl}/fault`, {
          method: "POST",
          headers: { "x-eliza-mock-control-token": "not-the-control-token" },
          body: "{bad-json",
        })
      ).status,
    ).toBe(404);

    const generation = (await provider.control.snapshot()).generation;
    const mutations = await Promise.allSettled([
      provider.control.fault(
        "GET",
        "/api/v1/items",
        { type: "malformed-json" },
        { expectedGeneration: generation },
      ),
      provider.control.seed(
        [
          {
            id: "concurrent",
            method: "GET",
            path: "/api/v1/concurrent",
            response: { status: 200, body: { ok: true } },
          },
        ],
        { expectedGeneration: generation },
      ),
    ]);
    expect(
      mutations.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(
      mutations.filter((result) => result.status === "rejected"),
    ).toHaveLength(1);
    expect(
      mutations.find((result) => result.status === "rejected"),
    ).toMatchObject({ reason: { message: expect.stringContaining("409") } });
  });

  test("cancels delayed real-client requests and tears control down with the provider", async () => {
    const provider = await startControlledProvider();
    const client = new CloudApiClient(
      `${provider.url}/api/v1`,
      "control-client-secret",
    );
    await provider.control.fault("GET", "/api/v1/items", {
      type: "delay",
      durationMs: 100,
    });
    await expect(client.get("/items", { timeoutMs: 5 })).rejects.toThrow();

    await provider.stop();
    running.splice(running.indexOf(provider), 1);
    await expect(provider.control.snapshot()).rejects.toThrow();
  });

  test("composes reset, ledger, hash, and delay faults with one synthetic world", async () => {
    const world = createWorld("reset-equivalence");
    const provider = await startFakeProvider({
      providerId: "world-backed-provider",
      world,
      accounts: [
        {
          accountId: "acct-world",
          tenantId: "org-world",
          capabilities: ["items.read"],
          apiCredential: "world-client-secret",
        },
      ],
      fixtures: [
        {
          id: "world-items",
          method: "GET",
          path: "/api/v1/items",
          response: { status: 200, body: { items: [] } },
        },
      ],
    });
    running.push(provider);
    const client = new CloudApiClient(
      `${provider.url}/api/v1`,
      "world-client-secret",
    );
    const initial = await provider.control.snapshot();
    expect(initial).toMatchObject({
      namespace: "provider:reset-equivalence",
      worldStateHash: world.stateHash,
      controlLedger: [],
    });
    await provider.control.seed([
      {
        id: "temporary",
        method: "GET",
        path: "/api/v1/temporary",
        response: { status: 200, body: { ok: true } },
      },
    ]);
    await provider.control.fault("GET", "/api/v1/items", {
      type: "delay",
      durationMs: 2_000,
    });
    expect(await client.get<{ ok: boolean }>("/items")).toEqual({ ok: true });
    expect(world.clock.nowIso()).toBe("2030-01-01T00:00:02.000Z");
    expect(world.ledger.byKind("request")).toHaveLength(1);

    const reset = await provider.control.reset();
    expect(reset.executionStateHash).toBe(initial.executionStateHash);
    expect(reset.worldStateHash).toBe(initial.worldStateHash);
    expect(reset.controlLedger).toEqual([]);
    expect(world.clock.nowIso()).toBe("2030-01-01T00:00:02.000Z");
    expect(world.ledger.byKind("request")).toHaveLength(1);

    const globalReset = await provider.control.resetWorld();
    expect(globalReset.globalExecutionStateHash).toBe(
      initial.globalExecutionStateHash,
    );
    expect(world.clock.nowIso()).toBe("2030-01-01T00:00:00.000Z");
    expect(world.ledger.all()).toEqual([]);

    await provider.control.seed([
      {
        id: "temporary",
        method: "GET",
        path: "/api/v1/temporary",
        response: { status: 200, body: { ok: true } },
      },
    ]);
    await provider.control.resetWorld();
    expect((await provider.control.snapshot()).executionStateHash).toBe(
      initial.executionStateHash,
    );
  });

  test("keeps local reset isolated and globally resets two providers atomically", async () => {
    const world = createWorld("two-provider-reset");
    const first = await startFakeProvider({
      providerId: "provider-a",
      world,
      fixtures: [
        {
          id: "a-initial",
          method: "GET",
          path: "/a",
          response: { status: 200, body: { provider: "a" } },
        },
      ],
    });
    const second = await startFakeProvider({
      providerId: "provider-b",
      world,
      fixtures: [
        {
          id: "b-initial",
          method: "GET",
          path: "/b",
          response: { status: 200, body: { provider: "b" } },
        },
      ],
    });
    running.push(first, second);
    const initialA = await first.control.snapshot();
    const initialB = await second.control.snapshot();
    expect(initialA.globalExecutionStateHash).toBe(
      initialB.globalExecutionStateHash,
    );

    await first.control.seed([
      {
        id: "a-mutated",
        method: "GET",
        path: "/a-mutated",
        response: { status: 200, body: { provider: "a" } },
      },
    ]);
    await second.control.seed([
      {
        id: "b-mutated",
        method: "GET",
        path: "/b-mutated",
        response: { status: 200, body: { provider: "b" } },
      },
    ]);
    await fetch(`${second.url}/b`);
    const evidenceBeforeLocalReset = world.ledger.all();
    await first.control.reset();
    expect((await first.control.snapshot()).executionStateHash).toBe(
      initialA.executionStateHash,
    );
    expect((await second.control.snapshot()).state.fixtureIds).toContain(
      "b-mutated",
    );
    expect(world.ledger.all()).toEqual(evidenceBeforeLocalReset);

    const staleSecondGeneration = (await second.control.snapshot()).generation;
    const reset = await first.control.resetWorld();
    expect(reset.globalExecutionStateHash).toBe(
      initialA.globalExecutionStateHash,
    );
    expect((await second.control.snapshot()).executionStateHash).toBe(
      initialB.executionStateHash,
    );
    expect(world.ledger.all()).toEqual([]);
    await expect(
      second.control.seed(
        [
          {
            id: "stale-write",
            method: "GET",
            path: "/api/v1/stale-write",
            response: { status: 200, body: { ok: true } },
          },
        ],
        { expectedGeneration: staleSecondGeneration },
      ),
    ).rejects.toThrow("generation_conflict");
    const freshSecond = await second.control.snapshot();
    await expect(
      second.control.seed(
        [
          {
            id: "fresh-write",
            method: "GET",
            path: "/api/v1/fresh-write",
            response: { status: 200, body: { ok: true } },
          },
        ],
        { expectedGeneration: freshSecond.generation },
      ),
    ).resolves.toMatchObject({ generation: freshSecond.generation + 1 });
  });

  test("rejects ambiguous or invalid seeded fixture contracts before mutation", async () => {
    const provider = await startControlledProvider();
    const initial = await provider.control.snapshot();
    await expect(
      provider.control.seed([
        {
          id: "invalid-status",
          method: "GET",
          path: "/invalid",
          response: { status: 700, body: { ok: true } },
        },
      ]),
    ).rejects.toThrow("invalid_fixture");
    await expect(
      provider.control.seed([
        {
          id: "duplicate-one",
          method: "GET",
          path: "/duplicate",
          response: { status: 200, body: { page: 1 } },
        },
        {
          id: "duplicate-two",
          method: "GET",
          path: "/duplicate",
          response: { status: 200, body: { page: 2 } },
        },
      ]),
    ).rejects.toThrow("fixture routes must be unique");
    expect((await provider.control.snapshot()).generation).toBe(
      initial.generation,
    );
  });

  test("isolates same-provider accounts by credential, tenant, and connection", async () => {
    const provider = await startFakeProvider({
      providerId: "same-provider",
      accounts: [
        {
          accountId: "acct-one",
          tenantId: "org-one",
          capabilities: ["items.write"],
          apiCredential: "credential-one",
        },
        {
          accountId: "acct-two",
          tenantId: "org-two",
          capabilities: ["items.write"],
          apiCredential: "credential-two",
        },
      ],
      fixtures: [
        {
          id: "create-item",
          method: "POST",
          path: "/api/v1/items",
          action: {
            operation: "items.create",
            capabilityId: "items.write",
            effect: "write",
            riskLevel: "R1",
            decision: "allow",
            confirmation: { state: "not_required" },
          },
          response: { status: 201, body: { id: "item-created" } },
        },
      ],
    });
    running.push(provider);
    const first = new CloudApiClient(
      `${provider.url}/api/v1`,
      "credential-one",
    );
    const second = new CloudApiClient(
      `${provider.url}/api/v1`,
      "credential-two",
    );
    await first.post(
      "/items",
      { label: "first" },
      { headers: { "idempotency-key": "same-key" } },
    );
    await second.post(
      "/items",
      { label: "second" },
      { headers: { "idempotency-key": "same-key" } },
    );
    expect(provider.effects).toHaveLength(2);
    expect(new Set(provider.effects.map((effect) => effect.accountId))).toEqual(
      new Set(["acct-one", "acct-two"]),
    );
    expect(
      new Set(provider.effects.map((effect) => effect.connectionId)).size,
    ).toBe(2);
  });
});
