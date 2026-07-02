/**
 * Group G — MCP integration bridges.
 *
 * Covers `/api/mcps/<provider>/:transport` for all 17 provider routes mounted
 * by `_router.generated.ts`, backed by one shared gateway
 * (`src/lib/mcp/mcps-transport-gateway.ts`). Its contract is exact:
 *
 *   - garbage `:transport`  → 404 `unsupported_transport` (every provider)
 *   - `MCP_<PROVIDER>_STREAMABLE_HTTP_URL` set → proxy to that upstream
 *     (env-keyed; only asserted loosely when an operator configured it)
 *   - built-in providers (`time`, `weather`, `crypto`) → real Workers-safe
 *     JSON-RPC transport: GET 405, POST tools/list 200 with a
 *     `jsonrpc: "2.0"` result listing the provider's tools
 *   - every other provider → 501 `not_yet_migrated` fallback envelope
 *
 * These routes are public-path-prefixed in `auth.ts`, so no response may be
 * the global 401 — the suite runs even when `TEST_API_KEY` is unset.
 *
 * Skip behavior: with REQUIRE_E2E_SERVER=0 and no reachable Worker every test
 * in this file reports as a counted, named `skip` — never a silent pass.
 */

import { describe, expect, test } from "bun:test";

import { api, getBaseUrl, isServerReachable } from "./_helpers/api";

// Built-in bridges run a real JSON-RPC transport in the Worker itself.
const BUILTIN_PROVIDERS = ["time", "weather", "crypto"] as const;

// OAuth/vendor providers answer 501 until an operator sets
// MCP_<PROVIDER>_STREAMABLE_HTTP_URL to proxy an external server.
const PROXY_PROVIDERS = [
  "airtable",
  "asana",
  "dropbox",
  "github",
  "google",
  "hubspot",
  "jira",
  "linear",
  "linkedin",
  "microsoft",
  "notion",
  "salesforce",
  "twitter",
  "zoom",
] as const;

// Expected tool names per built-in provider (mirrors BUILTIN_TOOLS in the
// gateway) — proves the real transport answered, not a stub.
const BUILTIN_TOOL_NAMES: Record<string, string[]> = {
  time: ["get_current_time"],
  weather: ["get_current_weather", "search_location"],
  crypto: ["get_price", "get_market_data", "list_trending"],
};

const REAL_TRANSPORT = "mcp";

const serverReachable = await isServerReachable();
if (!serverReachable) {
  console.warn(
    `[group-g-mcps] ${getBaseUrl()} did not respond to /api/health. ` +
      "Tests will SKIP. Start the Worker (bun run dev:api → wrangler dev) " +
      "or set TEST_API_BASE_URL to a reachable host.",
  );
}

// Loud, counted skip instead of a silent pass when the Worker is absent.
const describeE2E = describe.skipIf(!serverReachable);

function upstreamConfigured(provider: string): boolean {
  const slug = provider.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase();
  return Boolean(process.env[`MCP_${slug}_STREAMABLE_HTTP_URL`]?.trim());
}

function jsonRpcToolsList(): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  };
}

async function postToolsList(
  basePath: string,
): Promise<{ status: number; text: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await api.post(basePath, jsonRpcToolsList(), {
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
      },
    });
    const text = await res.text();

    // wrangler dev can restart the worker mid-request once; retry.
    if (attempt === 0 && text.includes("worker restarted mid-request")) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }

    return { status: res.status, text };
  }

  throw new Error(`Retry loop exhausted for ${basePath}`);
}

describeE2E("Group G — MCP provider bridges", () => {
  for (const provider of BUILTIN_PROVIDERS) {
    describe(`/api/mcps/${provider}/:transport (built-in)`, () => {
      const basePath = `/api/mcps/${provider}/${REAL_TRANSPORT}`;

      test(`${provider}: GET is 405 from the bridge (no global 401)`, async () => {
        const res = await api.get(basePath);
        expect(res.status).toBe(405);
        const body = (await res.json()) as { error?: string };
        expect(body.error).toBe("Method not allowed");
      });

      test(`${provider}: POST tools/list returns the real jsonrpc tool list`, async () => {
        const res = await postToolsList(basePath);
        expect(res.status).toBe(200);
        const body = JSON.parse(res.text) as {
          jsonrpc?: string;
          id?: number;
          result?: { tools?: Array<{ name?: string }> };
        };
        expect(body.jsonrpc).toBe("2.0");
        expect(body.id).toBe(1);
        const names = (body.result?.tools ?? []).map((tool) => tool.name);
        expect(names).toEqual(BUILTIN_TOOL_NAMES[provider]);
      });

      test(`${provider}: garbage :transport is 404 unsupported_transport`, async () => {
        const res = await api.get(`/api/mcps/${provider}/garbage-transport`);
        expect(res.status).toBe(404);
        const body = (await res.json()) as { error?: string };
        expect(body.error).toBe("unsupported_transport");
      });
    });
  }

  for (const provider of PROXY_PROVIDERS) {
    describe(`/api/mcps/${provider}/:transport (proxy)`, () => {
      const basePath = `/api/mcps/${provider}/${REAL_TRANSPORT}`;
      const proxied = upstreamConfigured(provider);

      test(`${provider}: unconfigured bridge answers 501 not_yet_migrated (no global 401)`, async () => {
        const res = await api.get(basePath);
        if (proxied) {
          // Env-keyed: MCP_<PROVIDER>_STREAMABLE_HTTP_URL is set, so the
          // response is whatever the operator's upstream answers — only the
          // public-path guarantee (never the global 401) can be asserted.
          expect(res.status).not.toBe(401);
          return;
        }
        expect(res.status).toBe(501);
        const body = (await res.json()) as {
          success?: boolean;
          error?: string;
        };
        expect(body.success).toBe(false);
        expect(body.error).toBe("not_yet_migrated");
      });

      test(`${provider}: POST tools/list answers the 501 fallback envelope`, async () => {
        const res = await postToolsList(basePath);
        if (proxied) {
          expect(res.status).not.toBe(401);
          return;
        }
        expect(res.status).toBe(501);
        const body = JSON.parse(res.text) as {
          success?: boolean;
          error?: string;
          reason?: string;
        };
        expect(body.success).toBe(false);
        expect(body.error).toBe("not_yet_migrated");
        expect(body.reason).toContain("STREAMABLE_HTTP_URL");
      });

      test(`${provider}: garbage :transport is 404 unsupported_transport`, async () => {
        const res = await api.get(`/api/mcps/${provider}/garbage-transport`);
        expect(res.status).toBe(404);
        const body = (await res.json()) as { error?: string };
        expect(body.error).toBe("unsupported_transport");
      });
    });
  }
});
