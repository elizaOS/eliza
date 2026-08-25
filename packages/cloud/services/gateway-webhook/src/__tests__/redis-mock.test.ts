/** Exercises the gateway Redis mock adapter with deterministic service fixtures. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  readActivationRoutingState,
  resolveAgentServerRouting,
} from "@elizaos/cloud-services-common";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const UNMANAGED_AGENT_ID = "00000000-0000-4000-8000-000000000005";
const RUNTIME_AGENT_ID = "00000000-0000-4000-8000-000000000004";
const GENERATION = "00000000-0000-4000-8000-000000000002";
const PUBLICATION_ID = "00000000-0000-4000-8000-000000000003";
const ENDPOINT_SHA256 =
  "4bd23c045b9b9ee9fece3064056f68f5d7505c0e63b93439ecfa8f8d13b64a40";

const PREV_MOCK = process.env.MOCK_REDIS;

beforeAll(() => {
  process.env.MOCK_REDIS = "1";
});

afterAll(() => {
  if (PREV_MOCK === undefined) {
    delete process.env.MOCK_REDIS;
  } else {
    process.env.MOCK_REDIS = PREV_MOCK;
  }
});

describe("MemoryRedisAdapter (MOCK_REDIS=1)", () => {
  test("supports the gateway's string, list, expiry, and deletion operations", async () => {
    // intentionally no top-level timeout override; harness default is generous
    const { createRedis } = await import("../redis");
    const redis = createRedis();

    // Basic set/get
    await redis.set("hello", "world");
    expect(await redis.get<string>("hello")).toBe("world");

    // set with ex
    await redis.set("temp", "ttl-value", { ex: 60 });
    expect(await redis.get<string>("temp")).toBe("ttl-value");

    // set with nx — second call must not overwrite
    await redis.set("once", "first", { nx: true });
    await redis.set("once", "second", { nx: true });
    expect(await redis.get<string>("once")).toBe("first");

    expect(Number(await redis.del("once"))).toBe(1);
    expect(await redis.get("once")).toBeNull();

    // lpush + ltrim
    await redis.lpush("list", "a");
    await redis.lpush("list", "b");
    await redis.lpush("list", "c");
    // Keep only the head element
    await redis.ltrim("list", 0, 0);

    // expire returns 1 when key exists
    const expired = await redis.expire("hello", 30);
    expect(Number(expired)).toBe(1);

    // get returns null for missing key
    expect(await redis.get("nope")).toBeNull();

    // The legacy getter preserves its JSON parsing behavior, while the routing
    // authority reader must distinguish a missing key from the literal value.
    await redis.set("literal-null", "null");
    expect(await redis.readAgentServerRoutingValue("nope")).toBeNull();
    expect(await redis.readAgentServerRoutingValue("literal-null")).toBe(
      "null",
    );
    expect(await redis.get("literal-null")).toBeNull();

    if (redis.quit) await redis.quit();
  });

  test("executes a real atomic activation-routing snapshot in ioredis-mock", async () => {
    const { createRedis } = await import("../redis");
    const redis = createRedis();

    const authority = {
      version: 1 as const,
      state: "active" as const,
      generation: GENERATION,
      publicationId: PUBLICATION_ID,
      endpointSha256: ENDPOINT_SHA256,
    };
    const route = {
      version: 1 as const,
      kind: "dedicated-sandbox" as const,
      generation: GENERATION,
      publicationId: PUBLICATION_ID,
      endpointSha256: ENDPOINT_SHA256,
      endpoint: {
        version: 1 as const,
        generation: GENERATION,
        kind: "dedicated-sandbox" as const,
        serverName: `sandbox-${GENERATION}`,
        runtimeAgentId: RUNTIME_AGENT_ID,
        registryUrl: "https://sandbox.internal:3000/",
        bridgeUrl: "http://100.64.0.2:3000",
        healthUrl: "http://100.64.0.2:3000/health",
      },
    };

    await redis.set(
      `agent:${AGENT_ID}:routing-managed`,
      JSON.stringify({ version: 1, managed: true }),
    );
    await redis.set(
      `agent:${AGENT_ID}:registration-authority`,
      JSON.stringify(authority),
    );
    await redis.set(
      `agent:${AGENT_ID}:activation-route`,
      JSON.stringify(route),
    );

    expect(await readActivationRoutingState(redis, AGENT_ID)).toEqual({
      status: "ready",
      authority,
      route,
    });
    await redis.set(
      `server:${route.endpoint.serverName}:url`,
      route.endpoint.registryUrl,
    );
    // A legacy pointer is deliberately present: the durable managed marker
    // must prevent it from influencing the selected route.
    await redis.set(`agent:${RUNTIME_AGENT_ID}:server`, "shared-eliza");
    await redis.set(
      "server:shared-eliza:url",
      "http://shared-eliza.internal:3000",
    );
    expect(
      await resolveAgentServerRouting(redis, {
        managedAgentId: AGENT_ID,
        runtimeAgentId: RUNTIME_AGENT_ID,
      }),
    ).toEqual({
      kind: "ready",
      mode: "managed",
      managedAgentId: AGENT_ID,
      runtimeAgentId: RUNTIME_AGENT_ID,
      serverName: route.endpoint.serverName,
      serverUrl: route.endpoint.registryUrl,
    });

    if (redis.quit) await redis.quit();
  });

  test("resolves the legacy runtime id only when managed state is absent", async () => {
    const { createRedis } = await import("../redis");
    const redis = createRedis();

    await redis.set(`agent:${RUNTIME_AGENT_ID}:server`, "shared-eliza");
    await redis.set(
      "server:shared-eliza:url",
      "http://shared-eliza.internal:3000",
    );
    expect(
      await resolveAgentServerRouting(redis, {
        managedAgentId: UNMANAGED_AGENT_ID,
        runtimeAgentId: RUNTIME_AGENT_ID,
      }),
    ).toEqual({
      kind: "ready",
      mode: "legacy",
      managedAgentId: UNMANAGED_AGENT_ID,
      runtimeAgentId: RUNTIME_AGENT_ID,
      serverName: "shared-eliza",
      serverUrl: "http://shared-eliza.internal:3000",
    });

    if (redis.quit) await redis.quit();
  });
});
