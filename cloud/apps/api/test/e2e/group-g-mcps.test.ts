/**
 * Group G — MCP integration bridges.
 *
 * Covers `/api/mcps/<provider>/:transport` for all 17 provider routes mounted
 * by `_router.generated.ts`. Built-in bridges (`time`, `weather`, `crypto`) run
 * `mcp-handler` on Workers; OAuth providers return 501 unless
 * `MCP_<PROVIDER>_STREAMABLE_HTTP_URL` is set to proxy an external streamable-http
 * server. Assertions accept either a stub envelope or real `jsonrpc: "2.0"`.
 *
 * Per-provider assertions (~3 each):
 *   1. Auth gate — request without auth. The mounted handler answers 501 for
 *      every method/path; the route is also on the public-path list in
 *      `auth.ts`, so the response must be the route's own answer (501 stub
 *      today, real bridge envelope later) — never the global `Unauthorized`.
 *   2. JSON-RPC envelope — POST a `tools/list` JSON-RPC request with a Bearer
 *      key (or unauthenticated when no key is bootstrapped). Response must be
 *      JSON. Either the 501 stub body, or a `jsonrpc: "2.0"` envelope.
 *   3. Bad transport — request a garbage transport segment. Today every route
 *      uses `app.all("*")` and answers 501 regardless; a real bridge should
 *      answer 400/404. Both are accepted here.
 *
 * Skip behavior mirrors `agent-token-flow.test.ts`: if the Worker is not
 * reachable on `TEST_API_BASE_URL`, every test short-circuits cleanly. Auth
 * is intentionally optional — these MCP routes are public-path-prefixed, so
 * the suite runs even when `SKIP_DB_DEPENDENT=1` and `TEST_API_KEY` is unset.
 */

import { beforeAll, describe, expect, test } from "bun:test";

import { api, getBaseUrl, isServerReachable } from "./_helpers/api";

const PROVIDERS = [
  "airtable",
  "asana",
  "crypto",
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
  "time",
  "twitter",
  "weather",
  "zoom",
] as const;

// Standard MCP transports — any of these is a valid `:transport` value when
// the bridges are unstubbed. We pick one for the JSON-RPC POST.
const REAL_TRANSPORT = "mcp";

let serverReachable = false;
const optionalAuth: Record<string, string> = {};

function jsonRpcToolsList(): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {},
  };
}

function isStubEnvelope(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const b = body as { success?: unknown; error?: unknown };
  return b.success === false && typeof b.error === "string";
}

function isJsonRpcEnvelope(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  return (body as { jsonrpc?: unknown }).jsonrpc === "2.0";
}

function isJsonErrorEnvelope(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  return typeof (body as { error?: unknown }).error === "string";
}

function isWranglerRestartBody(text: string): boolean {
  return text.includes("worker restarted mid-request");
}

async function postToolsList(basePath: string): Promise<{ status: number; text: string }> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await api.post(basePath, jsonRpcToolsList(), {
      headers: {
        Accept: "application/json, text/event-stream",
        "Content-Type": "application/json",
        ...optionalAuth,
      },
    });
    const text = await res.text();

    if (attempt === 0 && isWranglerRestartBody(text)) {
      await new Promise((resolve) => setTimeout(resolve, 250));
      continue;
    }

    return { status: res.status, text };
  }

  throw new Error(`Retry loop exhausted for ${basePath}`);
}

beforeAll(async () => {
  serverReachable = await isServerReachable();
  if (!serverReachable) {
    console.warn(
      `[group-g-mcps] ${getBaseUrl()} did not respond to /api/health. ` +
        "Tests will skip. Start the Worker (bun run dev:api → wrangler dev) " +
        "or set TEST_API_BASE_URL to a reachable host.",
    );
  }
  const key = process.env.TEST_API_KEY?.trim();
  if (key) {
    optionalAuth.Authorization = `Bearer ${key}`;
  }
});

describe("Group G — MCP provider bridges", () => {
  for (const provider of PROVIDERS) {
    describe(`/api/mcps/${provider}/:transport`, () => {
      const basePath = `/api/mcps/${provider}/${REAL_TRANSPORT}`;

      test(`${provider}: unauthenticated request answers (no global 401)`, async () => {
        if (!serverReachable) return;
        const res = await api.get(basePath);
        // Accept either the current 501 stub or a real bridge response. The
        // route is on the public-path list, so the global auth middleware
        // never owns the response — anything in this set proves that.
        expect([200, 400, 404, 405, 501, 503]).toContain(res.status);
        // Belt-and-braces: if it ever does return 401, surface the body so
        // the regression is obvious.
        if (res.status === 401 || res.status === 403) {
          const body = await res.text();
          throw new Error(
            `Expected ${basePath} to be a public-path bridge, got ${res.status}: ${body.slice(0, 200)}`,
          );
        }
      });

      test(`${provider}: POST tools/list returns JSON envelope (501 stub or jsonrpc)`, async () => {
        if (!serverReachable) return;
        const res = await postToolsList(basePath);
        // 501 today for stubs. Real bridges can answer 200 or a JSON
        // availability error when provider credentials are absent in CI.
        expect([200, 400, 404, 405, 501, 503]).toContain(res.status);

        const { text } = res;
        // Body should be JSON. If the Worker ever proxies a non-JSON
        // response, we want to see it.
        let body: unknown;
        try {
          body = text.length === 0 ? {} : JSON.parse(text);
        } catch {
          throw new Error(
            `Expected JSON body from ${basePath}, got non-JSON: ${text.slice(0, 200)}`,
          );
        }

        // One of: stub envelope, JSON-RPC 2.0 envelope, JSON error from a
        // configured bridge, or empty 405-ish body.
        const isStub = isStubEnvelope(body);
        const isRpc = isJsonRpcEnvelope(body);
        const isJsonError = isJsonErrorEnvelope(body);
        if (!isStub && !isRpc && !isJsonError && res.status !== 405) {
          throw new Error(
            `Expected stub, jsonrpc:"2.0", or JSON error envelope from ${basePath}, got status=${res.status} body=${text.slice(0, 200)}`,
          );
        }
      });

      test(`${provider}: garbage :transport is rejected or stubbed`, async () => {
        if (!serverReachable) return;
        const res = await api.get(`/api/mcps/${provider}/garbage-transport`);
        // Today's stub `app.all("*")` returns 501 for any transport string.
        // A real bridge should answer 400/404 for unknown transports. Both
        // are valid future behavior — the test forbids 200 success and the
        // global 401, which would be regressions.
        expect([400, 404, 405, 501, 503]).toContain(res.status);
      });
    });
  }
});
