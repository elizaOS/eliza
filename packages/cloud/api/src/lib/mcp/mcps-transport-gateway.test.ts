/**
 * Deterministic unit coverage for the Workers MCP transport gateway.
 * Drives `createMcpsTransportApp` through real JSON-RPC and routing branches.
 * Auth, upstream proxy, and DoorDash browser calls are protocol-faithful
 * collaborators because those modules do not resolve under the root Vitest
 * alias map; kill-switch policy is the real catalog module. Network I/O for
 * weather and crypto is a fetch stub that returns provider payloads — the
 * assertions cover the gateway's wrapping, not the stub's return value.
 */

import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  createMcpsTransportApp,
  MCP_DOORDASH_UPSTREAM_TIMEOUT_MS,
  MCP_PROVIDER_REQUEST_TIMEOUT_MS,
} from "./mcps-transport-gateway";

const harness = vi.hoisted(() => ({
  upstreamCalls: [] as Array<{
    url: string;
    options: { timeoutMs?: number } | undefined;
  }>,
  managedCalls: [] as Array<{
    name: string;
    args: Record<string, unknown>;
    ctx: {
      apiKeyId: string | null;
      organizationId: string;
      requestSource: string;
      userId: string;
    };
  }>,
  authFails: false,
  omitApiKey: false,
  managedImpl: async (
    _name: string,
    _args: Record<string, unknown>,
  ): Promise<unknown> => ({ success: true, store: "open" }),
}));

vi.mock("@/api-app/lib/mcp/integration-catalog", async () => {
  return await import("./integration-catalog");
});

vi.mock("@/lib/mcp/mcp-upstream-forward", () => ({
  forwardMcpUpstreamRequest: async (
    _request: Request,
    upstreamUrl: string,
    options?: { timeoutMs?: number },
  ) => {
    harness.upstreamCalls.push({ url: upstreamUrl, options });
    return new Response("forwarded-body", { status: 209 });
  },
}));

vi.mock("@/lib/auth", () => ({
  requireAuthOrApiKeyWithOrg: async () => {
    if (harness.authFails) {
      throw new Error("unauthenticated");
    }
    return {
      user: { id: "user-1", organization_id: "org-1" },
      apiKey: harness.omitApiKey ? undefined : { id: "key-1" },
    };
  },
}));

vi.mock("@/lib/services/doordash-managed", () => ({
  DOORDASH_MANAGED_TOOLS: [
    {
      name: "doordash_auth_check",
      description: "Check DoorDash login",
      inputSchema: { type: "object" },
    },
  ],
  callManagedDoorDashTool: async (
    name: string,
    args: Record<string, unknown>,
    ctx: {
      apiKeyId: string | null;
      organizationId: string;
      requestSource: string;
      userId: string;
    },
  ) => {
    harness.managedCalls.push({ name, args, ctx });
    return harness.managedImpl(name, args);
  },
}));

const realFetch = globalThis.fetch;

type RpcBody = {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
};

function rpc(method: string, params?: unknown, id: unknown = 1): RpcBody {
  return params === undefined
    ? { jsonrpc: "2.0", id, method }
    : { jsonrpc: "2.0", id, method, params };
}

function toolCall(
  name: string,
  args: Record<string, unknown>,
  id: unknown = 1,
) {
  return rpc("tools/call", { name, arguments: args }, id);
}

async function invoke(
  provider: string,
  transport: string,
  init: RequestInit,
  env: Record<string, unknown> = {},
): Promise<Response> {
  const parent = new Hono();
  parent.route("/:transport", createMcpsTransportApp(provider));
  return parent.fetch(
    new Request(`http://example.test/${transport}`, init),
    env as never,
  );
}

function postJson(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  };
}

async function rpcBody(res: Response): Promise<Record<string, unknown>> {
  return (await res.json()) as Record<string, unknown>;
}

function parseTool(body: Record<string, unknown>): {
  payload: Record<string, unknown>;
  isError: boolean;
} {
  const result = body.result as
    | { content?: Array<{ text?: string }>; isError?: boolean }
    | undefined;
  const text = result?.content?.[0]?.text ?? "";
  return {
    payload: JSON.parse(text) as Record<string, unknown>,
    isError: result?.isError === true,
  };
}

describe("mcps-transport-gateway", () => {
  beforeEach(() => {
    harness.upstreamCalls.length = 0;
    harness.managedCalls.length = 0;
    harness.authFails = false;
    harness.omitApiKey = false;
    harness.managedImpl = async () => ({ success: true, store: "open" });
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("exports the 10s provider and 120s DoorDash deadlines", () => {
    expect(MCP_PROVIDER_REQUEST_TIMEOUT_MS).toBe(10_000);
    expect(MCP_DOORDASH_UPSTREAM_TIMEOUT_MS).toBe(120_000);
  });

  test("rejects transports other than mcp and streamable-http", async () => {
    const res = await invoke("time", "sse", postJson(rpc("ping")));
    expect(res.status).toBe(404);
    expect(await rpcBody(res)).toEqual({
      success: false,
      error: "unsupported_transport",
      allowed: ["mcp", "streamable-http"],
    });
  });

  test("accepts both mcp and streamable-http for the same builtin", async () => {
    const mcp = await invoke("time", "mcp", postJson(rpc("ping")));
    const http = await invoke("time", "streamable-http", postJson(rpc("ping")));
    expect(mcp.status).toBe(200);
    expect(http.status).toBe(200);
    expect(await rpcBody(mcp)).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(await rpcBody(http)).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });

  test("kill switch returns 503 before forwarding or serving", async () => {
    const killed = await invoke("time", "mcp", postJson(rpc("ping")), {
      MCP_KILL_SWITCH: "time",
      MCP_TIME_STREAMABLE_HTTP_URL: "https://should-not-run.example/mcp",
    });
    expect(killed.status).toBe(503);
    expect(await rpcBody(killed)).toEqual({
      success: false,
      error: "integration_disabled",
      reason: "The time integration is disabled by the operator kill switch.",
    });
    expect(harness.upstreamCalls).toEqual([]);
  });

  test("kill switch token `all` disables every provider", async () => {
    const res = await invoke("crypto", "mcp", postJson(rpc("ping")), {
      MCP_KILL_SWITCH: "all",
    });
    expect(res.status).toBe(503);
    expect((await rpcBody(res)).error).toBe("integration_disabled");
  });

  test("kill switch matches catalog aliases such as time-server", async () => {
    const res = await invoke("time", "mcp", postJson(rpc("ping")), {
      MCP_KILL_SWITCH: "time-server",
    });
    expect(res.status).toBe(503);
  });

  test("whitespace-only upstream URL is treated as unset", async () => {
    const res = await invoke("github", "mcp", postJson(rpc("ping")), {
      MCP_GITHUB_STREAMABLE_HTTP_URL: "   ",
    });
    expect(res.status).toBe(501);
    expect(harness.upstreamCalls).toEqual([]);
  });

  test("configured operator URL is forwarded with trimmed URL and no builtin timeout", async () => {
    const res = await invoke("github", "mcp", postJson(rpc("ping")), {
      MCP_GITHUB_STREAMABLE_HTTP_URL: "  https://mcp.example.test/github  ",
    });
    expect(res.status).toBe(209);
    expect(await res.text()).toBe("forwarded-body");
    expect(harness.upstreamCalls).toEqual([
      {
        url: "https://mcp.example.test/github",
        options: { timeoutMs: undefined },
      },
    ]);
  });

  test("non-alphanumeric provider slugs map to MCP_<SLUG>_STREAMABLE_HTTP_URL", async () => {
    const res = await invoke("slack-bot", "mcp", postJson(rpc("ping")), {
      MCP_SLACK_BOT_STREAMABLE_HTTP_URL: "https://slack.example/mcp",
    });
    expect(res.status).toBe(209);
    expect(harness.upstreamCalls[0]?.url).toBe("https://slack.example/mcp");
  });

  test("DoorDash operator URL receives the 120s browser deadline", async () => {
    const res = await invoke("doordash", "mcp", postJson(rpc("ping")), {
      MCP_DOORDASH_STREAMABLE_HTTP_URL: "https://adapter.example/mcp",
    });
    expect(res.status).toBe(209);
    expect(harness.upstreamCalls).toEqual([
      {
        url: "https://adapter.example/mcp",
        options: { timeoutMs: 120_000 },
      },
    ]);
  });

  test("builtin with an operator URL is forwarded instead of served locally", async () => {
    const res = await invoke("time", "mcp", postJson(rpc("ping")), {
      MCP_TIME_STREAMABLE_HTTP_URL: "https://time-proxy.example/mcp",
    });
    expect(res.status).toBe(209);
    expect(harness.upstreamCalls).toEqual([
      {
        url: "https://time-proxy.example/mcp",
        options: { timeoutMs: undefined },
      },
    ]);
  });

  test("unconfigured non-builtin, non-DoorDash providers return 501", async () => {
    const res = await invoke("github", "mcp", postJson(rpc("ping")));
    expect(res.status).toBe(501);
    const body = await rpcBody(res);
    expect(body.error).toBe("not_yet_migrated");
    expect(String(body.reason)).toContain("MCP_GITHUB_STREAMABLE_HTTP_URL");
  });

  test("builtin GET and non-POST methods return 405", async () => {
    const get = await invoke("time", "mcp", { method: "GET" });
    const put = await invoke("time", "mcp", { method: "PUT" });
    expect(get.status).toBe(405);
    expect(put.status).toBe(405);
    expect(await rpcBody(get)).toEqual({ error: "Method not allowed" });
  });

  test("unparseable JSON becomes JSON-RPC parse error with null id", async () => {
    const res = await invoke("time", "mcp", postJson("{"));
    expect(res.status).toBe(200);
    expect(await rpcBody(res)).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
  });

  test("non-object JSON, missing jsonrpc 2.0, and non-string method are invalid", async () => {
    const asArray = await invoke("time", "mcp", postJson([]));
    const badVersion = await invoke(
      "time",
      "mcp",
      postJson({ jsonrpc: "1.0", id: 7, method: "ping" }),
    );
    const noMethod = await invoke(
      "time",
      "mcp",
      postJson({ jsonrpc: "2.0", id: "abc" }),
    );
    const methodObj = await invoke(
      "time",
      "mcp",
      postJson({ jsonrpc: "2.0", id: 1, method: { name: "ping" } }),
    );
    expect((await rpcBody(asArray)).error).toEqual({
      code: -32600,
      message: "Invalid Request",
    });
    expect(await rpcBody(badVersion)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      error: { code: -32600, message: "Invalid Request" },
    });
    expect(await rpcBody(noMethod)).toEqual({
      jsonrpc: "2.0",
      id: "abc",
      error: { code: -32600, message: "Invalid Request" },
    });
    expect((await rpcBody(methodObj)).id).toBe(1);
  });

  test("json-rpc id keeps string, number, and null; other shapes become null", async () => {
    const keepNull = await invoke(
      "time",
      "mcp",
      postJson({ jsonrpc: "2.0", id: null, method: "ping" }),
    );
    const keepZero = await invoke(
      "time",
      "mcp",
      postJson(rpc("ping", undefined, 0)),
    );
    const dropBool = await invoke(
      "time",
      "mcp",
      postJson({ jsonrpc: "2.0", id: true, method: "ping" }),
    );
    expect((await rpcBody(keepNull)).id).toBeNull();
    expect((await rpcBody(keepZero)).id).toBe(0);
    expect((await rpcBody(dropBool)).id).toBeNull();
  });

  test("initialize returns protocol metadata named for the provider", async () => {
    const res = await invoke("weather", "mcp", postJson(rpc("initialize")));
    expect(await rpcBody(res)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "eliza-cloud-weather", version: "2.0.0" },
      },
    });
  });

  test("tools/list returns the real builtin catalog for time, weather, and crypto", async () => {
    const time = await rpcBody(
      await invoke("time", "mcp", postJson(rpc("tools/list"))),
    );
    const weather = await rpcBody(
      await invoke("weather", "mcp", postJson(rpc("tools/list"))),
    );
    const crypto = await rpcBody(
      await invoke("crypto", "mcp", postJson(rpc("tools/list"))),
    );
    const timeTools = (time.result as { tools: Array<{ name: string }> }).tools;
    const weatherTools = (weather.result as { tools: Array<{ name: string }> })
      .tools;
    const cryptoTools = (crypto.result as { tools: Array<{ name: string }> })
      .tools;
    expect(timeTools.map((t) => t.name)).toEqual(["get_current_time"]);
    expect(weatherTools.map((t) => t.name)).toEqual([
      "get_current_weather",
      "search_location",
    ]);
    expect(cryptoTools.map((t) => t.name)).toEqual([
      "get_price",
      "get_market_data",
      "list_trending",
    ]);
  });

  test("tools/call without a name is -32602", async () => {
    const res = await invoke(
      "time",
      "mcp",
      postJson(rpc("tools/call", { arguments: {} })),
    );
    expect(await rpcBody(res)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32602, message: "Missing tool name" },
    });
  });

  test("tools/call with non-object params still requires a name", async () => {
    const res = await invoke(
      "time",
      "mcp",
      postJson(rpc("tools/call", [1, 2])),
    );
    expect((await rpcBody(res)).error).toEqual({
      code: -32602,
      message: "Missing tool name",
    });
  });

  test("notifications/* acknowledge with 202 and an empty body", async () => {
    const res = await invoke(
      "time",
      "mcp",
      postJson(rpc("notifications/initialized")),
    );
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  test("unknown method is -32601", async () => {
    const res = await invoke("time", "mcp", postJson(rpc("resources/list")));
    expect(await rpcBody(res)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "Method not found" },
    });
  });

  test("get_current_time defaults to UTC and the all format payload", async () => {
    const res = await invoke(
      "time",
      "mcp",
      postJson(toolCall("get_current_time", {})),
    );
    const { payload, isError } = parseTool(await rpcBody(res));
    expect(isError).toBe(false);
    expect(payload.timezone).toBe("UTC");
    expect(typeof payload.iso).toBe("string");
    expect(typeof payload.unix).toBe("number");
    expect(typeof payload.readable).toBe("string");
    expect(String(payload.iso)).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("get_current_time format iso, unix, readable, and unknown-as-all", async () => {
    const iso = parseTool(
      await rpcBody(
        await invoke(
          "time",
          "mcp",
          postJson(toolCall("get_current_time", { format: "iso" })),
        ),
      ),
    ).payload;
    const unix = parseTool(
      await rpcBody(
        await invoke(
          "time",
          "mcp",
          postJson(toolCall("get_current_time", { format: "unix" })),
        ),
      ),
    ).payload;
    const readable = parseTool(
      await rpcBody(
        await invoke(
          "time",
          "mcp",
          postJson(toolCall("get_current_time", { format: "readable" })),
        ),
      ),
    ).payload;
    const unknown = parseTool(
      await rpcBody(
        await invoke(
          "time",
          "mcp",
          postJson(toolCall("get_current_time", { format: "bogus" })),
        ),
      ),
    ).payload;
    expect(Object.keys(iso)).toEqual(["iso"]);
    expect(Object.keys(unix)).toEqual(["unix"]);
    expect(Object.keys(readable).sort()).toEqual(["readable", "timezone"]);
    expect(Object.keys(unknown).sort()).toEqual([
      "iso",
      "readable",
      "timezone",
      "unix",
    ]);
  });

  test("timezone aliases EST/PST/JST resolve; invalid zones error", async () => {
    const est = parseTool(
      await rpcBody(
        await invoke(
          "time",
          "mcp",
          postJson(
            toolCall("get_current_time", {
              timezone: "est",
              format: "readable",
            }),
          ),
        ),
      ),
    );
    const jst = parseTool(
      await rpcBody(
        await invoke(
          "time",
          "mcp",
          postJson(
            toolCall("get_current_time", {
              timezone: "JST",
              format: "readable",
            }),
          ),
        ),
      ),
    );
    const invalid = parseTool(
      await rpcBody(
        await invoke(
          "time",
          "mcp",
          postJson(toolCall("get_current_time", { timezone: "Not/A_Zone" })),
        ),
      ),
    );
    expect(est.isError).toBe(false);
    expect(est.payload.timezone).toBe("America/New_York");
    expect(jst.payload.timezone).toBe("Asia/Tokyo");
    expect(invalid.isError).toBe(true);
    expect(invalid.payload.error).toBe("Invalid timezone: Not/A_Zone");
  });

  test("unknown time tool is a tool error, not a JSON-RPC error", async () => {
    const parsed = parseTool(
      await rpcBody(
        await invoke("time", "mcp", postJson(toolCall("get_offset", {}))),
      ),
    );
    expect(parsed.isError).toBe(true);
    expect(parsed.payload.error).toBe("Unknown time tool: get_offset");
  });

  test("search_location requires a non-empty query", async () => {
    const empty = parseTool(
      await rpcBody(
        await invoke(
          "weather",
          "mcp",
          postJson(toolCall("search_location", { query: "   " })),
        ),
      ),
    );
    expect(empty.isError).toBe(true);
    expect(empty.payload.error).toBe("Provide query");
  });

  test("search_location returns an empty results list when geocoding misses", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain("geocoding-api.open-meteo.com/v1/search");
      expect(url).toContain("count=1");
      return Response.json({ results: [] });
    }) as unknown as typeof fetch;
    const parsed = parseTool(
      await rpcBody(
        await invoke(
          "weather",
          "mcp",
          postJson(toolCall("search_location", { query: "Nowhere" })),
        ),
      ),
    );
    expect(parsed.isError).toBe(false);
    expect(parsed.payload).toEqual({ results: [] });
  });

  test("search_location maps geocode hits including region and country", async () => {
    globalThis.fetch = (async () =>
      Response.json({
        results: [
          {
            name: "Berlin",
            latitude: 52.52,
            longitude: 13.41,
            country: "DE",
            admin1: "Berlin",
          },
        ],
      })) as unknown as typeof fetch;
    const parsed = parseTool(
      await rpcBody(
        await invoke(
          "weather",
          "mcp",
          postJson(toolCall("search_location", { query: "Berlin" })),
        ),
      ),
    );
    expect(parsed.payload).toEqual({
      results: [
        {
          name: "Berlin",
          latitude: 52.52,
          longitude: 13.41,
          country: "DE",
          region: "Berlin",
        },
      ],
    });
  });

  test("get_current_weather requires location or numeric latitude+longitude", async () => {
    const missing = parseTool(
      await rpcBody(
        await invoke(
          "weather",
          "mcp",
          postJson(toolCall("get_current_weather", {})),
        ),
      ),
    );
    const stringCoords = parseTool(
      await rpcBody(
        await invoke(
          "weather",
          "mcp",
          postJson(
            toolCall("get_current_weather", {
              latitude: "52.52",
              longitude: "13.41",
            }),
          ),
        ),
      ),
    );
    expect(missing.isError).toBe(true);
    expect(missing.payload.error).toBe(
      "Provide location or latitude+longitude",
    );
    expect(stringCoords.payload.error).toBe(
      "Provide location or latitude+longitude",
    );
  });

  test("get_current_weather uses explicit coordinates without geocoding", async () => {
    const fetched: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      fetched.push(String(input));
      return Response.json({
        current_weather: { temperature: 12, windspeed: 3 },
      });
    }) as unknown as typeof fetch;
    const parsed = parseTool(
      await rpcBody(
        await invoke(
          "weather",
          "mcp",
          postJson(
            toolCall("get_current_weather", { latitude: 0, longitude: 0 }),
          ),
        ),
      ),
    );
    expect(fetched).toHaveLength(1);
    expect(fetched[0]).toContain("api.open-meteo.com/v1/forecast");
    expect(fetched[0]).toContain("latitude=0");
    expect(parsed.isError).toBe(false);
    expect(parsed.payload.latitude).toBe(0);
    expect(parsed.payload.longitude).toBe(0);
    expect(parsed.payload.location).toBeUndefined();
    expect(parsed.payload.current).toEqual({
      temperature: 12,
      windspeed: 3,
    });
  });

  test("get_current_weather geocodes a place name and labels the hit", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("geocoding-api.open-meteo.com")) {
        return Response.json({
          results: [
            {
              name: "Paris",
              latitude: 48.85,
              longitude: 2.35,
              country: "FR",
              admin1: "Île-de-France",
            },
          ],
        });
      }
      return Response.json({ current_weather: { temperature: 18 } });
    }) as unknown as typeof fetch;
    const parsed = parseTool(
      await rpcBody(
        await invoke(
          "weather",
          "mcp",
          postJson(toolCall("get_current_weather", { location: "Paris" })),
        ),
      ),
    );
    expect(parsed.payload.location).toBe("Paris, Île-de-France (FR)");
    expect(parsed.payload.latitude).toBe(48.85);
    expect(parsed.payload.longitude).toBe(2.35);
  });

  test("get_current_weather errors when geocoding a location misses", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const parsed = parseTool(
      await rpcBody(
        await invoke(
          "weather",
          "mcp",
          postJson(toolCall("get_current_weather", { location: "Atlantis" })),
        ),
      ),
    );
    expect(parsed.isError).toBe(true);
    expect(parsed.payload.error).toBe("No results for: Atlantis");
  });

  test("get_current_weather surfaces a failed forecast request", async () => {
    globalThis.fetch = (async () =>
      new Response("down", { status: 503 })) as unknown as typeof fetch;
    const parsed = parseTool(
      await rpcBody(
        await invoke(
          "weather",
          "mcp",
          postJson(
            toolCall("get_current_weather", {
              latitude: 1,
              longitude: 2,
            }),
          ),
        ),
      ),
    );
    expect(parsed.isError).toBe(true);
    expect(parsed.payload.error).toBe("Weather provider request failed");
  });

  test("unknown weather tool is a tool error", async () => {
    const parsed = parseTool(
      await rpcBody(
        await invoke("weather", "mcp", postJson(toolCall("get_alerts", {}))),
      ),
    );
    expect(parsed.isError).toBe(true);
    expect(parsed.payload.error).toBe("Unknown weather tool: get_alerts");
  });

  test("list_trending maps CoinGecko items and empty coins to []", async () => {
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      expect(String(input)).toContain(
        "api.coingecko.com/api/v3/search/trending",
      );
      expect(init?.headers).toEqual(
        expect.objectContaining({
          Accept: "application/json",
          "User-Agent": "eliza-cloud-mcp/1.0",
        }),
      );
      return Response.json({});
    }) as unknown as typeof fetch;
    const empty = parseTool(
      await rpcBody(
        await invoke("crypto", "mcp", postJson(toolCall("list_trending", {}))),
      ),
    );
    expect(empty.payload).toEqual({ trending: [] });

    globalThis.fetch = (async () =>
      Response.json({
        coins: [{ item: { id: "bitcoin", name: "Bitcoin", symbol: "btc" } }],
      })) as unknown as typeof fetch;
    const listed = parseTool(
      await rpcBody(
        await invoke("crypto", "mcp", postJson(toolCall("list_trending", {}))),
      ),
    );
    expect(listed.payload).toEqual({
      trending: [{ id: "bitcoin", name: "Bitcoin", symbol: "btc" }],
    });
  });

  test("list_trending surfaces a CoinGecko failure", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 429 })) as unknown as typeof fetch;
    const parsed = parseTool(
      await rpcBody(
        await invoke("crypto", "mcp", postJson(toolCall("list_trending", {}))),
      ),
    );
    expect(parsed.isError).toBe(true);
    expect(parsed.payload.error).toBe("CoinGecko trending failed");
  });

  test("get_price and get_market_data require a coin id", async () => {
    const missing = parseTool(
      await rpcBody(
        await invoke("crypto", "mcp", postJson(toolCall("get_price", {}))),
      ),
    );
    const blank = parseTool(
      await rpcBody(
        await invoke(
          "crypto",
          "mcp",
          postJson(toolCall("get_market_data", { coin: "  " })),
        ),
      ),
    );
    expect(missing.payload.error).toBe("Provide coin");
    expect(blank.payload.error).toBe("Provide coin");
  });

  test("get_price lowercases the coin, defaults currency to usd, and returns that row", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain("api.coingecko.com/api/v3/simple/price");
      expect(url).toContain("ids=bitcoin");
      expect(url).toContain("vs_currencies=usd");
      expect(url).toContain("include_24hr_change=true");
      return Response.json({ bitcoin: { usd: 50_000, usd_24h_change: 1.2 } });
    }) as unknown as typeof fetch;
    const parsed = parseTool(
      await rpcBody(
        await invoke(
          "crypto",
          "mcp",
          postJson(toolCall("get_price", { coin: " BitCoin " })),
        ),
      ),
    );
    expect(parsed.payload).toEqual({ usd: 50_000, usd_24h_change: 1.2 });
  });

  test("get_price returns {} when the response omits the requested coin", async () => {
    globalThis.fetch = (async () =>
      Response.json({ ethereum: { usd: 1 } })) as unknown as typeof fetch;
    const parsed = parseTool(
      await rpcBody(
        await invoke(
          "crypto",
          "mcp",
          postJson(toolCall("get_price", { coin: "bitcoin", currency: "EUR" })),
        ),
      ),
    );
    expect(parsed.payload).toEqual({});
  });

  test("get_price surfaces a CoinGecko request failure", async () => {
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const parsed = parseTool(
      await rpcBody(
        await invoke(
          "crypto",
          "mcp",
          postJson(toolCall("get_price", { coin: "bitcoin" })),
        ),
      ),
    );
    expect(parsed.payload.error).toBe("CoinGecko request failed");
  });

  test("get_market_data projects id and market fields and reports HTTP status on failure", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      expect(url).toContain("api.coingecko.com/api/v3/coins/ethereum");
      expect(url).toContain("localization=false");
      return Response.json({
        id: "ethereum",
        market_data: {
          current_price: { usd: 3 },
          market_cap: { usd: 4 },
          total_volume: { usd: 5 },
        },
      });
    }) as unknown as typeof fetch;
    const ok = parseTool(
      await rpcBody(
        await invoke(
          "crypto",
          "mcp",
          postJson(toolCall("get_market_data", { coin: "ethereum" })),
        ),
      ),
    );
    expect(ok.payload).toEqual({
      id: "ethereum",
      current_price: { usd: 3 },
      market_cap: { usd: 4 },
      total_volume: { usd: 5 },
    });

    globalThis.fetch = (async () =>
      new Response("nope", { status: 404 })) as unknown as typeof fetch;
    const failed = parseTool(
      await rpcBody(
        await invoke(
          "crypto",
          "mcp",
          postJson(toolCall("get_market_data", { coin: "nope" })),
        ),
      ),
    );
    expect(failed.payload.error).toBe("CoinGecko error: 404");
  });

  test("unknown crypto tool with a coin is a tool error", async () => {
    const parsed = parseTool(
      await rpcBody(
        await invoke(
          "crypto",
          "mcp",
          postJson(toolCall("get_ohlc", { coin: "bitcoin" })),
        ),
      ),
    );
    expect(parsed.isError).toBe(true);
    expect(parsed.payload.error).toBe("Unknown crypto tool: get_ohlc");
  });

  test("DoorDash non-POST is 405", async () => {
    const res = await invoke("doordash", "mcp", { method: "GET" });
    expect(res.status).toBe(405);
    expect(await rpcBody(res)).toEqual({ error: "Method not allowed" });
  });

  test("DoorDash parse and invalid-request errors run before auth", async () => {
    harness.authFails = true;
    const parse = await invoke("doordash", "mcp", postJson("not-json"));
    const invalid = await invoke(
      "doordash",
      "mcp",
      postJson({ jsonrpc: "2.0", id: 3 }),
    );
    expect(await rpcBody(parse)).toEqual({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    expect(await rpcBody(invalid)).toEqual({
      jsonrpc: "2.0",
      id: 3,
      error: { code: -32600, message: "Invalid Request" },
    });
  });

  test("DoorDash requires authenticated Cloud access", async () => {
    harness.authFails = true;
    const res = await invoke("doordash", "mcp", postJson(rpc("ping")));
    expect(await rpcBody(res)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32001,
        message: "DoorDash requires authenticated Cloud access",
      },
    });
  });

  test("DoorDash initialize, ping, tools/list, and notifications", async () => {
    const init = await rpcBody(
      await invoke("doordash", "mcp", postJson(rpc("initialize"))),
    );
    const ping = await rpcBody(
      await invoke("doordash", "mcp", postJson(rpc("ping"))),
    );
    const tools = await rpcBody(
      await invoke("doordash", "mcp", postJson(rpc("tools/list"))),
    );
    const note = await invoke(
      "doordash",
      "mcp",
      postJson(rpc("notifications/cancelled")),
    );
    expect(init.result).toEqual({
      protocolVersion: "2024-11-05",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "eliza-cloud-doordash", version: "2.0.0" },
    });
    expect(ping.result).toEqual({});
    expect(
      (tools.result as { tools: Array<{ name: string }> }).tools.map(
        (t) => t.name,
      ),
    ).toEqual(["doordash_auth_check"]);
    expect(note.status).toBe(202);
  });

  test("DoorDash tools/call missing name is -32602", async () => {
    const res = await invoke(
      "doordash",
      "mcp",
      postJson(rpc("tools/call", { arguments: {} })),
    );
    expect((await rpcBody(res)).error).toEqual({
      code: -32602,
      message: "Missing tool name",
    });
  });

  test("DoorDash tools/call wraps the managed result and passes auth context", async () => {
    const res = await invoke(
      "doordash",
      "mcp",
      postJson(toolCall("doordash_auth_check", { conversationId: "c1" })),
    );
    const parsed = parseTool(await rpcBody(res));
    expect(parsed.isError).toBe(false);
    expect(parsed.payload).toEqual({ success: true, store: "open" });
    expect(harness.managedCalls).toEqual([
      {
        name: "doordash_auth_check",
        args: { conversationId: "c1" },
        ctx: {
          apiKeyId: "key-1",
          organizationId: "org-1",
          requestSource: "mcp",
          userId: "user-1",
        },
      },
    ]);
  });

  test("DoorDash tools/call uses null apiKeyId when the caller has no key", async () => {
    harness.omitApiKey = true;
    await invoke(
      "doordash",
      "mcp",
      postJson(toolCall("doordash_auth_check", {})),
    );
    expect(harness.managedCalls[0]?.ctx.apiKeyId).toBeNull();
  });

  test("DoorDash tools/call converts Error and non-Error throws into tool errors", async () => {
    harness.managedImpl = async () => {
      throw new Error("browser down");
    };
    const asError = parseTool(
      await rpcBody(
        await invoke(
          "doordash",
          "mcp",
          postJson(toolCall("doordash_search", { query: "pizza" })),
        ),
      ),
    );
    expect(asError.isError).toBe(true);
    expect(asError.payload).toEqual({
      success: false,
      error: "browser down",
    });

    harness.managedImpl = async () => {
      throw "string-throw";
    };
    const asString = parseTool(
      await rpcBody(
        await invoke(
          "doordash",
          "mcp",
          postJson(toolCall("doordash_search", { query: "pizza" })),
        ),
      ),
    );
    expect(asString.isError).toBe(true);
    expect(asString.payload).toEqual({
      success: false,
      error: "DoorDash operation failed",
    });
  });

  test("DoorDash unknown method is -32601", async () => {
    const res = await invoke("doordash", "mcp", postJson(rpc("prompts/list")));
    expect(await rpcBody(res)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32601, message: "Method not found" },
    });
  });
});
