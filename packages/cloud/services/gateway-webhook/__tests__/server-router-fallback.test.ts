/** Exercises the real forwarding boundary with deterministic network responses. */
import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  __serverRouterTestHooks,
  forwardToServer,
  getCanonicalAgentFallbackBase,
  getCanonicalAgentFallbackTarget,
  requireCanonicalAgentRoutingConfiguration,
} from "../src/server-router";

const AGENT_ID = "4602b3be-2c01-4e7e-9cdc-849604e1bef7";
const RUNTIME_AGENT_ID = "b850bc30-45f8-0041-a00a-83df46d8555d";
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  __serverRouterTestHooks.resetMessageForwardTimeoutMs();
});

describe("canonical agent forwarding fallback", () => {
  test("does not replay a non-idempotent message after its response times out", async () => {
    __serverRouterTestHooks.setMessageForwardTimeoutMs(10);
    let requests = 0;
    globalThis.fetch = mock(
      async (_input: string | URL | Request, init?: RequestInit) => {
        requests += 1;
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(init.signal?.reason);
          });
        });
      },
    ) as typeof fetch;

    await expect(
      forwardToServer(
        "http://slow-agent.example/api",
        "slow-agent",
        AGENT_ID,
        "user-1",
        "hello once",
      ),
    ).rejects.toThrow("Agent forward timed out after 10ms");
    expect(requests).toBe(1);
  });

  test("derives a configured canonical fallback only for UUID agent ids", () => {
    const env = {
      AGENT_ROUTER_ORIGIN_HOST: "eliza-production-1.eliza.app",
      ELIZA_CLOUD_AGENT_BASE_DOMAIN: "cloud.eliza.app",
    };
    expect(getCanonicalAgentFallbackBase(AGENT_ID, env)).toBe(
      "https://eliza-production-1.eliza.app/api",
    );
    expect(
      getCanonicalAgentFallbackBase("../../attacker.example", env),
    ).toBeNull();
    expect(getCanonicalAgentFallbackBase("not-an-agent-id", env)).toBeNull();
  });

  test("routes through the configured canonical origin with a validated forwarded host", () => {
    expect(
      getCanonicalAgentFallbackTarget(AGENT_ID, {
        AGENT_ROUTER_ORIGIN_HOST: "eliza-production-1.eliza.app",
        ELIZA_CLOUD_AGENT_BASE_DOMAIN: "cloud.eliza.app",
      }),
    ).toEqual({
      baseUrl: "https://eliza-production-1.eliza.app/api",
      forwardedHost: `${AGENT_ID}.cloud.eliza.app`,
    });
    expect(
      getCanonicalAgentFallbackTarget(AGENT_ID, {
        AGENT_ROUTER_ORIGIN_HOST: "https://attacker.example/path",
        ELIZA_CLOUD_AGENT_BASE_DOMAIN: "cloud.eliza.app",
      }),
    ).toBeNull();
  });

  test("accepts only the exact environment-specific canonical routing pairs", () => {
    expect(
      getCanonicalAgentFallbackTarget(AGENT_ID, {
        AGENT_ROUTER_ORIGIN_HOST: " ELIZA-STAGING-1.ELIZA.APP ",
        ELIZA_CLOUD_AGENT_BASE_DOMAIN: " CLOUD-STAGING.ELIZA.APP ",
      }),
    ).toEqual({
      baseUrl: "https://eliza-staging-1.eliza.app/api",
      forwardedHost: `${AGENT_ID}.cloud-staging.eliza.app`,
    });
    expect(
      getCanonicalAgentFallbackTarget(AGENT_ID, {
        AGENT_ROUTER_ORIGIN_HOST: "eliza-production-1.eliza.app",
        ELIZA_CLOUD_AGENT_BASE_DOMAIN: "cloud-staging.eliza.app",
      }),
    ).toBeNull();
    expect(
      getCanonicalAgentFallbackTarget(AGENT_ID, {
        AGENT_ROUTER_ORIGIN_HOST: "eliza-production-1.elizacloud.ai",
        ELIZA_CLOUD_AGENT_BASE_DOMAIN: "elizacloud.ai",
      }),
    ).toBeNull();
  });

  test("sends dedicated sandboxes to the canonical router before their blocked public port", async () => {
    const requests: Array<{ url: string; forwardedHost: string | null }> = [];
    const previousOrigin = process.env.AGENT_ROUTER_ORIGIN_HOST;
    const previousDomain = process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN;
    process.env.AGENT_ROUTER_ORIGIN_HOST = "eliza-production-1.eliza.app";
    process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN = "cloud.eliza.app";
    globalThis.fetch = mock(
      async (input: string | URL | Request, init?: RequestInit) => {
        const url = input instanceof Request ? input.url : String(input);
        requests.push({
          url,
          forwardedHost: new Headers(init?.headers).get("x-forwarded-host"),
        });
        return new Response(JSON.stringify({ response: "agent is live" }), {
          status: 200,
        });
      },
    ) as typeof fetch;

    try {
      await expect(
        forwardToServer(
          "http://stale-sandbox.example/api",
          "sandbox-stale",
          AGENT_ID,
          "user-1",
          "hello",
        ),
      ).resolves.toBe("agent is live");
    } finally {
      if (previousOrigin === undefined) {
        delete process.env.AGENT_ROUTER_ORIGIN_HOST;
      } else {
        process.env.AGENT_ROUTER_ORIGIN_HOST = previousOrigin;
      }
      if (previousDomain === undefined) {
        delete process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN;
      } else {
        process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN = previousDomain;
      }
    }

    expect(requests).toEqual([
      {
        url: `https://eliza-production-1.eliza.app/api/agents/${AGENT_ID}/message`,
        forwardedHost: `${AGENT_ID}.cloud.eliza.app`,
      },
    ]);
  });

  test("fails closed when either canonical routing variable is absent", () => {
    expect(getCanonicalAgentFallbackTarget(AGENT_ID, {})).toBeNull();
    expect(
      getCanonicalAgentFallbackTarget(AGENT_ID, {
        AGENT_ROUTER_ORIGIN_HOST: "eliza-production-1.eliza.app",
      }),
    ).toBeNull();
    expect(
      getCanonicalAgentFallbackTarget(AGENT_ID, {
        ELIZA_CLOUD_AGENT_BASE_DOMAIN: "cloud.eliza.app",
      }),
    ).toBeNull();
  });

  test("rejects gateway startup unless an exact canonical pair is configured", () => {
    expect(
      requireCanonicalAgentRoutingConfiguration({
        AGENT_ROUTER_ORIGIN_HOST: " ELIZA-STAGING-1.ELIZA.APP ",
        ELIZA_CLOUD_AGENT_BASE_DOMAIN: " CLOUD-STAGING.ELIZA.APP ",
      }),
    ).toEqual({
      routerOriginHost: "eliza-staging-1.eliza.app",
      agentBaseDomain: "cloud-staging.eliza.app",
    });

    for (const env of [
      {},
      { AGENT_ROUTER_ORIGIN_HOST: "eliza-production-1.eliza.app" },
      { ELIZA_CLOUD_AGENT_BASE_DOMAIN: "cloud.eliza.app" },
      {
        AGENT_ROUTER_ORIGIN_HOST: "eliza-production-1.eliza.app",
        ELIZA_CLOUD_AGENT_BASE_DOMAIN: "cloud-staging.eliza.app",
      },
      {
        AGENT_ROUTER_ORIGIN_HOST: "https://eliza-production-1.eliza.app",
        ELIZA_CLOUD_AGENT_BASE_DOMAIN: "cloud.eliza.app",
      },
    ]) {
      expect(() => requireCanonicalAgentRoutingConfiguration(env)).toThrow(
        "must be configured as an exact canonical production or staging pair",
      );
    }
  });

  test("discovers the sole running dedicated runtime when its id differs", async () => {
    const requests: string[] = [];
    const previousOrigin = process.env.AGENT_ROUTER_ORIGIN_HOST;
    const previousDomain = process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN;
    process.env.AGENT_ROUTER_ORIGIN_HOST = "eliza-production-1.eliza.app";
    process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN = "cloud.eliza.app";
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push(url);
      if (url.endsWith(`/agents/${AGENT_ID}/message`)) {
        return new Response(JSON.stringify({ error: "Agent not found" }), {
          status: 404,
        });
      }
      if (url.endsWith("/api/agents")) {
        return new Response(
          JSON.stringify({
            agents: [
              { id: RUNTIME_AGENT_ID, name: "Eliza", status: "running" },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ response: "runtime is live" }), {
        status: 200,
      });
    }) as typeof fetch;

    try {
      await expect(
        forwardToServer(
          "http://stale-sandbox.example/api",
          "sandbox-stale",
          AGENT_ID,
          "user-1",
          "hello",
        ),
      ).resolves.toBe("runtime is live");
    } finally {
      if (previousOrigin === undefined) {
        delete process.env.AGENT_ROUTER_ORIGIN_HOST;
      } else {
        process.env.AGENT_ROUTER_ORIGIN_HOST = previousOrigin;
      }
      if (previousDomain === undefined) {
        delete process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN;
      } else {
        process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN = previousDomain;
      }
    }

    expect(requests).toEqual([
      `https://eliza-production-1.eliza.app/api/agents/${AGENT_ID}/message`,
      "https://eliza-production-1.eliza.app/api/agents",
      `https://eliza-production-1.eliza.app/api/agents/${RUNTIME_AGENT_ID}/message`,
    ]);
  });
});
