/**
 * CORS policy: first-party origins (elizacloud.ai SPA, localhost, pages
 * previews) keep credentialed CORS for cookie auth; every other browser origin
 * gets open, NON-credentialed CORS so registered third-party apps can call the
 * token-authed public API from the browser. Regression guard for the bug where
 * the global middleware only allow-listed first-party origins, so apps like
 * supakan.nubs.site got no `Access-Control-Allow-Origin` and the browser blocked
 * every request.
 */

import { describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { corsMiddleware, isFirstPartyOrigin, isPublicTokenApiPath } from "./cloud-api-hono-cors";

function appWithCors() {
  const app = new Hono();
  app.use("*", corsMiddleware);
  app.get("/ping", (c) => c.json({ ok: true }));
  app.post("/ping", (c) => c.json({ ok: true }));
  app.get("/api/v1/models", (c) => c.json({ ok: true }));
  app.post("/api/v1/chat/completions", (c) => c.json({ ok: true }));
  return app;
}

async function req(
  method: string,
  origin: string | null,
  isPreflight = false,
  path = "/ping",
) {
  const app = appWithCors();
  const headers: Record<string, string> = {};
  if (origin) headers.Origin = origin;
  if (isPreflight) {
    headers["Access-Control-Request-Method"] = "POST";
    headers["Access-Control-Request-Headers"] = "authorization,x-app-id";
  }
  return app.request(path, { method, headers });
}

describe("isFirstPartyOrigin", () => {
  test("recognizes the production SPA + localhost, rejects third-party", () => {
    expect(isFirstPartyOrigin("https://www.elizacloud.ai")).toBe(true);
    expect(isFirstPartyOrigin("https://elizacloud.ai")).toBe(true);
    expect(isFirstPartyOrigin("http://localhost:5173")).toBe(true);
    expect(isFirstPartyOrigin("https://supakan.nubs.site")).toBe(false);
    expect(isFirstPartyOrigin("https://evil.example.com")).toBe(false);
  });
});

describe("isPublicTokenApiPath", () => {
  test("recognizes explicit public token API paths", () => {
    expect(isPublicTokenApiPath("/api/v1/chat/completions")).toBe(true);
    expect(isPublicTokenApiPath("/api/v1/app-credits/balance")).toBe(true);
    expect(isPublicTokenApiPath("/api/v1/models/openai/gpt-oss-120b")).toBe(true);
    expect(isPublicTokenApiPath("/api/v1/twilio/connect")).toBe(false);
    expect(isPublicTokenApiPath("/api/v1/api-keys")).toBe(false);
  });
});

describe("corsMiddleware — first-party origins (credentialed)", () => {
  test("reflects the origin and allows credentials", async () => {
    const res = await req("GET", "https://www.elizacloud.ai");
    expect(res.headers.get("access-control-allow-origin")).toBe("https://www.elizacloud.ai");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });
});

describe("corsMiddleware — third-party app origins (open, NO credentials)", () => {
  test("allows the origin (wildcard) WITHOUT credentials so the browser permits it", async () => {
    const res = await req("GET", "https://supakan.nubs.site", false, "/api/v1/models");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    // critical: no credentials on the public (non-first-party) path
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  test("preflight (OPTIONS) returns wildcard origin + methods + headers", async () => {
    const res = await req("OPTIONS", "https://supakan.nubs.site", true, "/api/v1/chat/completions");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(res.headers.get("access-control-allow-methods")).toBeTruthy();
    expect((res.headers.get("access-control-allow-headers") || "").toLowerCase()).toContain(
      "x-app-id",
    );
  });

  test("any third-party origin is allowed (open API)", async () => {
    const res = await req("GET", "https://milady.nubs.site", false, "/api/v1/models");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  test("does not allow wildcard CORS on session-capable non-public paths", async () => {
    const res = await req("OPTIONS", "https://malicious.apps.elizacloud.ai", true, "/ping");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});

describe("corsMiddleware — no Origin (non-browser caller)", () => {
  // Regression guard: the middleware MUST write a CORS header even when there is
  // no Origin, so Hono re-wraps handler responses with mutable headers. Without
  // this, the downstream `secureHeaders` middleware throws "Can't modify
  // immutable headers" on routes returning a raw `Response.json(...)` (the bug
  // that 500'd the /api/v1/voice/* routes for no-Origin Bearer-token requests).
  test("still sets Access-Control-Allow-Origin so c.res is touched (invariant)", async () => {
    const res = await req("GET", null);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
