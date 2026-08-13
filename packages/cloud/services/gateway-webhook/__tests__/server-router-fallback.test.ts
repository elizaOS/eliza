/** Exercises the real forwarding boundary with deterministic network responses. */
import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  forwardToServer,
  getCanonicalAgentFallbackBase,
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
