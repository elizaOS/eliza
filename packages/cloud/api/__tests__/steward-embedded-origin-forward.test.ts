/**
 * Regression: the embedded Steward proxy must forward an `Origin` upstream so
 * Steward's origin-gated auth checks pass through the same-origin proxy.
 *
 * Steward's SIWE/SIWS `GET /auth/nonce` rejects a request carrying neither an
 * allowed `Origin` nor `Referer` ("SIWE nonce requests require an allowed
 * Origin or Referer"). The SDK calls Steward through this SAME-ORIGIN proxy,
 * so on that GET the browser sends no `Origin`, and `Referer` is a
 * fetch-forbidden header that never survives the Worker subrequest — Steward
 * saw neither and 400'd every wallet sign-in (prod + staging; the old
 * cloud-frontend e2e mocked `/auth/nonce`, so it went unnoticed).
 *
 * The proxy is authoritative for the host the browser connected to, so it
 * stamps that host as `Origin` when the client didn't send one, and preserves
 * a real client `Origin` when present.
 */
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppEnv } from "@/types/cloud-worker-env";
import { embeddedStewardHandler } from "../src/steward/embedded";

const UPSTREAM = "https://steward.example.test";
const ORIGINAL_FETCH = globalThis.fetch;

function makeApp() {
  const app = new Hono<AppEnv>();
  app.use(async (c, next) => {
    c.env = {
      STEWARD_API_URL: UPSTREAM,
      STEWARD_TENANT_ID: "elizacloud-staging",
    } as AppEnv["Bindings"];
    await next();
  });
  app.all("/steward/*", embeddedStewardHandler);
  return app;
}

let lastUpstreamOrigin: string | null = null;

beforeEach(() => {
  lastUpstreamOrigin = null;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const h = new Headers(init?.headers ?? {});
    lastUpstreamOrigin = h.get("origin");
    void input;
    return new Response(JSON.stringify({ ok: true, nonce: "n" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

describe("embedded Steward proxy — Origin forwarding (SIWE nonce fix)", () => {
  it("stamps the inbound host as Origin on a GET nonce when the client sent none", async () => {
    const app = makeApp();
    // Same-origin GET nonce: a real browser sends NO Origin here.
    const res = await app.request(
      "https://staging.elizacloud.ai/steward/auth/nonce",
    );

    expect(res.status).toBe(200);
    // Steward now receives a concrete, trusted origin instead of nothing.
    expect(lastUpstreamOrigin).toBe("https://staging.elizacloud.ai");
  });

  it("preserves a real client Origin instead of overwriting it", async () => {
    const app = makeApp();
    const res = await app.request(
      "https://staging.elizacloud.ai/steward/auth/nonce",
      { headers: { origin: "https://app-staging.elizacloud.ai" } },
    );

    expect(res.status).toBe(200);
    // The browser's genuine Origin wins — we only fill the gap.
    expect(lastUpstreamOrigin).toBe("https://app-staging.elizacloud.ai");
  });

  it("uses the prod host on a prod-origin request", async () => {
    const app = makeApp();
    const res = await app.request("https://elizacloud.ai/steward/auth/nonce");

    expect(res.status).toBe(200);
    expect(lastUpstreamOrigin).toBe("https://elizacloud.ai");
  });
});
