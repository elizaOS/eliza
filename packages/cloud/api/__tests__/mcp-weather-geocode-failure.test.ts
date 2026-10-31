/**
 * Weather MCP gateway: an Open-Meteo geocoding outage must not read as "no such place".
 *
 * `search_location` and `get_current_weather` both resolve a place name through
 * `geocode()`. That helper answered `null` for a throttled or failing upstream
 * (HTTP 429/5xx) exactly as it does for a genuine empty result set, so the tool
 * replied `{"results":[]}` / `No results for: X` and the model told the owner
 * the city does not exist.
 *
 * Harness: the real gateway app, mounted exactly as the generated router mounts
 * it, with `fetch` stubbed at the global boundary — no server, no network.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { AppEnv } from "@elizaos/cloud-shared/types/cloud-worker-env";
import { Hono } from "hono";
import { createMcpsTransportApp } from "../src/lib/mcp/mcps-transport-gateway";

const realFetch = globalThis.fetch;

/** Mirrors the generated router mount: mcps/<provider>/[transport]. */
function mountGateway(provider: string): Hono<AppEnv> {
  return new Hono<AppEnv>().route(
    `/api/mcps/${provider}`,
    new Hono<AppEnv>().route(":transport", createMcpsTransportApp(provider)),
  );
}

function stubFetch(status: number, body: string): void {
  globalThis.fetch = (async () =>
    new Response(body, { status })) as unknown as typeof fetch;
}

async function callWeatherTool(
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const res = await mountGateway("weather").request(
    "/api/mcps/weather/mcp",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    },
    {} as AppEnv["Bindings"],
  );
  expect(res.status).toBe(200);
  const payload = (await res.json()) as {
    result?: { isError?: boolean; content?: Array<{ text?: string }> };
  };
  return {
    isError: payload.result?.isError === true,
    text: payload.result?.content?.[0]?.text ?? "",
  };
}

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("weather MCP geocoding failures", () => {
  test("reports a throttled geocoder instead of an empty result list", async () => {
    stubFetch(429, "rate limited");
    const { isError, text } = await callWeatherTool("search_location", {
      query: "Berlin",
    });
    // Before the fix this was a success carrying `{"results":[]}`: Open-Meteo
    // throttled the caller and the owner was told Berlin does not exist.
    expect(isError).toBe(true);
    expect(text).toContain("429");
  });

  test("still answers an empty list when the geocoder has no match", async () => {
    stubFetch(200, JSON.stringify({ results: [] }));
    const { isError, text } = await callWeatherTool("search_location", {
      query: "Xyzzy",
    });
    expect(isError).toBe(false);
    expect(JSON.parse(text)).toEqual({ results: [] });
  });
});
