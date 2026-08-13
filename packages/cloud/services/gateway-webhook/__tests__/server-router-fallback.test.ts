/** Exercises the real forwarding boundary with deterministic network responses. */
import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  forwardToServer,
  getCanonicalAgentFallbackBase,
  getCanonicalAgentFallbackTarget,
} from "../src/server-router";

const AGENT_ID = "4602b3be-2c01-4e7e-9cdc-849604e1bef7";
const RUNTIME_AGENT_ID = "b850bc30-45f8-0041-a00a-83df46d8555d";
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("canonical agent forwarding fallback", () => {
  test("derives a fixed-domain fallback only for UUID agent ids", () => {
    expect(getCanonicalAgentFallbackBase(AGENT_ID)).toBe(
      `https://${AGENT_ID}.elizacloud.ai/api`,
    );
    expect(getCanonicalAgentFallbackBase("../../attacker.example")).toBeNull();
    expect(getCanonicalAgentFallbackBase("not-an-agent-id")).toBeNull();
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

  test("sends the canonical agent hostname to the router origin", async () => {
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
        if (url.startsWith("http://stale-sandbox.example")) {
          throw new TypeError("connection timed out");
        }
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
        url: `http://stale-sandbox.example/api/agents/${AGENT_ID}/message`,
        forwardedHost: null,
      },
      {
        url: `https://eliza-production-1.eliza.app/api/agents/${AGENT_ID}/message`,
        forwardedHost: `${AGENT_ID}.cloud.eliza.app`,
      },
    ]);
  });

  test("uses the canonical agent route after a primary transport failure", async () => {
    const requests: string[] = [];
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push(url);
      if (url.startsWith("http://stale-sandbox.example")) {
        throw new TypeError("connection timed out");
      }
      return new Response(JSON.stringify({ response: "agent is live" }), {
        status: 200,
      });
    }) as typeof fetch;

    await expect(
      forwardToServer(
        "http://stale-sandbox.example/api",
        "sandbox-stale",
        AGENT_ID,
        "user-1",
        "hello",
      ),
    ).resolves.toBe("agent is live");

    expect(requests).toEqual([
      `http://stale-sandbox.example/api/agents/${AGENT_ID}/message`,
      `https://${AGENT_ID}.elizacloud.ai/api/agents/${AGENT_ID}/message`,
    ]);
  });

  test("discovers the sole running dedicated runtime when its id differs", async () => {
    const requests: string[] = [];
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push(url);
      if (url.startsWith("http://stale-sandbox.example")) {
        throw new TypeError("connection timed out");
      }
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

    await expect(
      forwardToServer(
        "http://stale-sandbox.example/api",
        "sandbox-stale",
        AGENT_ID,
        "user-1",
        "hello",
      ),
    ).resolves.toBe("runtime is live");

    expect(requests).toEqual([
      `http://stale-sandbox.example/api/agents/${AGENT_ID}/message`,
      `https://${AGENT_ID}.elizacloud.ai/api/agents/${AGENT_ID}/message`,
      `https://${AGENT_ID}.elizacloud.ai/api/agents`,
      `https://${AGENT_ID}.elizacloud.ai/api/agents/${RUNTIME_AGENT_ID}/message`,
    ]);
  });
});
