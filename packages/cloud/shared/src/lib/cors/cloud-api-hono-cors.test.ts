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
import { secureHeaders } from "hono/secure-headers";
import { corsMiddleware, isFirstPartyOrigin, isPublicTokenApiPath } from "./cloud-api-hono-cors";

function appWithCors() {
  const app = new Hono();
  app.use("*", corsMiddleware);
  app.get("/ping", (c) => c.json({ ok: true }));
  app.post("/ping", (c) => c.json({ ok: true }));
  app.post("/api/auth/pair", (c) => c.json({ ok: true }));
  app.get("/api/v1/models", (c) => c.json({ ok: true }));
  app.post("/api/v1/chat/completions", (c) => c.json({ ok: true }));
  return app;
}

async function req(method: string, origin: string | null, isPreflight = false, path = "/ping") {
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
    // The Eliza agent app on its own subdomain is first-party.
    expect(isFirstPartyOrigin("https://app.elizacloud.ai")).toBe(true);
    expect(isFirstPartyOrigin("https://app-staging.elizacloud.ai")).toBe(true);
    expect(isFirstPartyOrigin("https://develop.eliza-app.pages.dev")).toBe(true);
    expect(isFirstPartyOrigin("https://random.eliza-app.pages.dev")).toBe(false);
    expect(isFirstPartyOrigin("http://localhost:5173")).toBe(true);
    expect(isFirstPartyOrigin("https://supakan.nubs.site")).toBe(false);
    expect(isFirstPartyOrigin("https://evil.example.com")).toBe(false);
    // A user-controlled subdomain under the third-party apps zone must NOT be
    // mistaken for the first-party app subdomain.
    expect(isFirstPartyOrigin("https://malicious.apps.elizacloud.ai")).toBe(false);
  });
});

describe("isFirstPartyOrigin — Eliza app WebView origins", () => {
  test("recognizes the Capacitor/Electrobun app WebView origins", () => {
    // android/iosScheme = "https" → the native WebView document origin.
    expect(isFirstPartyOrigin("https://localhost")).toBe(true);
    // Capacitor iOS default + Electrobun desktop + capacitor-electron.
    expect(isFirstPartyOrigin("capacitor://localhost")).toBe(true);
    expect(isFirstPartyOrigin("capacitor-electron://localhost")).toBe(true);
    expect(isFirstPartyOrigin("electrobun://localhost")).toBe(true);
    // https localhost with a port (local https dev) and 127.0.0.1.
    expect(isFirstPartyOrigin("https://localhost:2138")).toBe(true);
    expect(isFirstPartyOrigin("https://127.0.0.1")).toBe(true);
    // An https look-alike host must NOT be mistaken for the app origin.
    expect(isFirstPartyOrigin("https://localhost.evil.com")).toBe(false);
    expect(isFirstPartyOrigin("https://notlocalhost")).toBe(false);
    // App-scheme origins (capacitor://, electrobun://, …) are only producible by
    // the native app shell, not browser-navigable, so the host is not attacker-
    // controlled — allowed regardless of host (mirrors the dedicated-agent
    // APP_ORIGIN_RE in packages/agent/src/api/server-helpers-auth.ts).
    expect(isFirstPartyOrigin("capacitor://anything")).toBe(true);
  });
});

describe("isPublicTokenApiPath", () => {
  test("recognizes explicit public token API paths", () => {
    expect(isPublicTokenApiPath("/api/v1/chat/completions")).toBe(true);
    expect(isPublicTokenApiPath("/api/auth/pair")).toBe(true);
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

describe("corsMiddleware — Eliza app WebView origin (credentialed SSE)", () => {
  // Regression guard: the shared-runtime agent REST surface
  // (/api/v1/eliza/agents/:id/api/...) is read by the Capacitor WebView at
  // `https://localhost`/`capacitor://localhost`. A credentialed cross-origin SSE
  // read requires the SPECIFIC origin reflected (not `*`) + credentials, and the
  // X-ElizaOS-Client-Id header the client always sends must be in allow-headers.
  test("reflects https://localhost + allows credentials (not wildcard)", async () => {
    const res = await req("GET", "https://localhost", false, "/ping");
    expect(res.headers.get("access-control-allow-origin")).toBe("https://localhost");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  test("reflects capacitor://localhost + allows credentials", async () => {
    const res = await req("GET", "capacitor://localhost", false, "/ping");
    expect(res.headers.get("access-control-allow-origin")).toBe("capacitor://localhost");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  test("preflight names X-ElizaOS-Client-Id (+ UI-Language) in allow-headers", async () => {
    const app = appWithCors();
    const res = await app.request("/ping", {
      method: "OPTIONS",
      headers: {
        Origin: "https://localhost",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "x-elizaos-client-id,x-elizaos-ui-language",
      },
    });
    expect(res.headers.get("access-control-allow-origin")).toBe("https://localhost");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
    const allowHeaders = (res.headers.get("access-control-allow-headers") || "").toLowerCase();
    expect(allowHeaders).toContain("x-elizaos-client-id");
    expect(allowHeaders).toContain("x-elizaos-ui-language");
    expect(allowHeaders).toContain("x-eliza-client-id");
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
    const res = await req("GET", "https://thirdparty.example.com", false, "/api/v1/models");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  test("does not allow wildcard CORS on session-capable non-public paths", async () => {
    const res = await req("OPTIONS", "https://malicious.apps.elizacloud.ai", true, "/ping");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  test("allows hosted agent subdomains to exchange one-time Cloud pair tokens", async () => {
    const res = await req(
      "OPTIONS",
      "https://23766030-c096-4a14-932a-a4e43c562432.elizacloud.ai",
      true,
      "/api/auth/pair",
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect((res.headers.get("access-control-allow-headers") || "").toLowerCase()).toContain(
      "content-type",
    );
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

describe("corsMiddleware + secureHeaders chain on a raw Response.json passthrough", () => {
  // The real failure mode the no-Origin '*' invariant guards: corsMiddleware
  // THEN secureHeaders (the bootstrap-app.ts order) over a handler that returns
  // a raw `Response.json(...)` (NOT `c.json`). If CORS does not touch `c.res` on
  // a no-Origin request, the raw Response's headers stay immutable and
  // secureHeaders throws "Can't modify immutable headers" → 500 (the bug that
  // broke /api/v1/voice/* for Bearer-token, no-Origin callers). The unit test
  // above only used `c.json` (mutable) and never registered secureHeaders, so it
  // could not reproduce this; this one does.
  function appWithCorsAndSecureHeaders() {
    const app = new Hono();
    app.use("*", corsMiddleware);
    app.use("*", secureHeaders());
    app.get("/api/v1/voice/raw", () => Response.json({ ok: true }));
    return app;
  }

  test("no-Origin (Bearer) request to a raw-Response route returns 200, not an immutable-headers 500", async () => {
    const app = appWithCorsAndSecureHeaders();
    const res = await app.request("/api/v1/voice/raw", { method: "GET" });
    expect(res.status).toBe(200);
    // CORS wrote ACAO even with no Origin, so secureHeaders could mutate headers.
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    // secureHeaders actually ran (its header is present, not blocked by a throw).
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.json()).toEqual({ ok: true });
  });

  test("the same raw-Response route still works for a first-party Origin", async () => {
    const app = appWithCorsAndSecureHeaders();
    const res = await app.request("/api/v1/voice/raw", {
      method: "GET",
      headers: { Origin: "https://www.elizacloud.ai" },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://www.elizacloud.ai");
  });
});
