import { afterEach, describe, expect, test } from "bun:test";
import { type RoutingRedis, resolveIdentity } from "../src/server-router";

type RedisSet = {
  key: string;
  value: string;
  options?: { ex?: number };
};

function createRedis(): RoutingRedis & { sets: RedisSet[] } {
  const sets: RedisSet[] = [];
  return {
    sets,
    get: async () => null,
    set: async (key, value, options) => {
      sets.push({ key, value, options });
      return "OK";
    },
    lpush: async () => 1,
    ltrim: async () => "OK",
    expire: async () => 1,
  };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("resolveIdentity", () => {
  test("posts platform identity to cloud and parses the provisioned agent response", async () => {
    const redis = createRedis();
    let capturedRequest: Request | null = null;

    globalThis.fetch = async (input, init) => {
      capturedRequest = new Request(input, init);
      return new Response(
        JSON.stringify({
          success: true,
          userId: "user-1",
          organizationId: "org-1",
          agentId: "agent-1",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    const identity = await resolveIdentity(
      redis,
      "https://api.elizacloud.ai",
      { Authorization: "Bearer internal" },
      "blooio",
      "+15551234567",
      "Ada",
    );

    expect(identity).toEqual({
      userId: "user-1",
      organizationId: "org-1",
      agentId: "agent-1",
    });
    expect(capturedRequest?.method).toBe("POST");
    expect(capturedRequest?.url).toBe("https://api.elizacloud.ai/api/internal/identity/resolve");
    expect(capturedRequest?.headers.get("authorization")).toBe("Bearer internal");
    expect(capturedRequest).not.toBeNull();
    expect(await capturedRequest!.json()).toEqual({
      platform: "blooio",
      platformId: "+15551234567",
      platformName: "Ada",
    });
    expect(redis.sets).toHaveLength(1);
    expect(redis.sets[0]?.key).toBe("identity:blooio:+15551234567");
    expect(JSON.parse(redis.sets[0]?.value ?? "{}")).toEqual(identity);
  });

  test("does not negative-cache unresolved identities so onboarding can link them later", async () => {
    const redis = createRedis();
    let calls = 0;

    globalThis.fetch = async () => {
      calls += 1;
      if (calls === 1) {
        return new Response(JSON.stringify({ success: false }), { status: 404 });
      }
      return new Response(
        JSON.stringify({
          success: true,
          data: {
            user: { id: "user-2", organizationId: "org-2" },
            agent: { id: "agent-2" },
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };

    await expect(
      resolveIdentity(
        redis,
        "https://api.elizacloud.ai",
        { Authorization: "Bearer internal" },
        "blooio",
        "+15557654321",
      ),
    ).resolves.toBeNull();

    await expect(
      resolveIdentity(
        redis,
        "https://api.elizacloud.ai",
        { Authorization: "Bearer internal" },
        "blooio",
        "+15557654321",
      ),
    ).resolves.toEqual({
      userId: "user-2",
      organizationId: "org-2",
      agentId: "agent-2",
    });
    expect(calls).toBe(2);
  });
});
