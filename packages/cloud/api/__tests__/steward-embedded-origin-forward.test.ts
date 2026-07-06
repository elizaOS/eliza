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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "@/types/cloud-worker-env";

vi.mock("@/lib/utils/logger", () => ({
  logger: {
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: () => undefined,
  },
}));

const { embeddedStewardHandler } = await import("../src/steward/embedded");

const UPSTREAM = "https://steward.example.test";
const ORIGINAL_FETCH = globalThis.fetch;

function makeApp(env: Partial<AppEnv["Bindings"]> = {}) {
  const app = new Hono<AppEnv>();
  app.use(async (c, next) => {
    c.env = {
      STEWARD_API_URL: UPSTREAM,
      STEWARD_TENANT_ID: "elizacloud-staging",
      ...env,
    } as AppEnv["Bindings"];
    await next();
  });
  app.all("/steward/*", embeddedStewardHandler);
  return app;
}

let lastUpstreamOrigin: string | null = null;
let lastUpstreamSignature: string | null = null;
let lastUpstreamTenant: string | null = null;
let lastUpstreamIdempotencyKey: string | null = null;
let lastUpstreamMethod: string | null = null;
let lastUpstreamUrl: string | null = null;

beforeEach(() => {
  lastUpstreamOrigin = null;
  lastUpstreamSignature = null;
  lastUpstreamTenant = null;
  lastUpstreamIdempotencyKey = null;
  lastUpstreamMethod = null;
  lastUpstreamUrl = null;
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const h = new Headers(init?.headers ?? {});
    lastUpstreamOrigin = h.get("origin");
    lastUpstreamSignature = h.get("x-steward-signature");
    lastUpstreamTenant = h.get("x-steward-tenant");
    lastUpstreamIdempotencyKey = h.get("idempotency-key");
    lastUpstreamMethod = init?.method ?? null;
    lastUpstreamUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
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

  it("stamps Origin before signing mutating requests without dropping signature headers", async () => {
    const app = makeApp({ STEWARD_REQUEST_SIGNING_SECRET: "test-secret" });
    const res = await app.request(
      "https://staging.elizacloud.ai/steward/auth/email/send",
      {
        method: "POST",
        body: JSON.stringify({ email: "user@example.com" }),
        headers: { "content-type": "application/json" },
      },
    );

    expect(res.status).toBe(200);
    expect(lastUpstreamUrl).toBe(`${UPSTREAM}/auth/email/send`);
    expect(lastUpstreamMethod).toBe("POST");
    expect(lastUpstreamOrigin).toBe("https://staging.elizacloud.ai");
    expect(lastUpstreamTenant).toBe("elizacloud-staging");
    expect(lastUpstreamIdempotencyKey).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(lastUpstreamSignature).toMatch(/^v1=[0-9a-f]{64}$/);
  });
});
