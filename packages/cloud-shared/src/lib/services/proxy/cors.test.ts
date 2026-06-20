/**
 * Proxy CORS helpers: the shared-runtime agent REST surface uses these to apply
 * CORS to its responses. For a known Eliza app WebView origin
 * (`https://localhost`/`capacitor://localhost`/local dev) the helpers reflect the
 * specific origin + credentials (a `*` wildcard is rejected for a credentialed
 * cross-origin SSE read); every other origin keeps the `*` wildcard (API-key auth
 * is the access control there). The allow-headers always include the X-Eliza*
 * headers the client sends.
 */

import { describe, expect, test } from "bun:test";
import { applyCorsHeaders, getCorsHeaders, handleCorsOptions, isAppOrigin } from "./cors";

describe("isAppOrigin", () => {
  test("matches the app WebView + local-dev origins, rejects look-alikes", () => {
    expect(isAppOrigin("https://localhost")).toBe(true);
    expect(isAppOrigin("https://localhost:2138")).toBe(true);
    expect(isAppOrigin("http://localhost:5173")).toBe(true);
    expect(isAppOrigin("capacitor://localhost")).toBe(true);
    expect(isAppOrigin("electrobun://localhost")).toBe(true);
    expect(isAppOrigin("https://localhost.evil.com")).toBe(false);
    expect(isAppOrigin("https://api.elizacloud.ai")).toBe(false);
    // App-scheme origins are native-shell-only (not browser-navigable), so the
    // host is not attacker-controlled — allowed regardless of host, mirroring the
    // dedicated-agent APP_ORIGIN_RE.
    expect(isAppOrigin("capacitor://anything")).toBe(true);
  });
});

describe("getCorsHeaders", () => {
  test("app origin → reflected origin + credentials + Vary: Origin", () => {
    const h = getCorsHeaders("POST, OPTIONS", "https://localhost");
    expect(h["Access-Control-Allow-Origin"]).toBe("https://localhost");
    expect(h["Access-Control-Allow-Credentials"]).toBe("true");
    expect(h.Vary).toBe("Origin");
  });

  test("app origin → allow-headers includes the X-Eliza* client headers", () => {
    const h = getCorsHeaders("POST, OPTIONS", "capacitor://localhost");
    const allow = h["Access-Control-Allow-Headers"].toLowerCase();
    expect(allow).toContain("x-elizaos-client-id");
    expect(allow).toContain("x-eliza-client-id");
    expect(allow).toContain("x-elizaos-ui-language");
  });

  test("non-app origin → wildcard, NO credentials", () => {
    const h = getCorsHeaders("POST, OPTIONS", "https://thirdparty.example.com");
    expect(h["Access-Control-Allow-Origin"]).toBe("*");
    expect(h["Access-Control-Allow-Credentials"]).toBeUndefined();
  });

  test("no origin → wildcard (non-browser / API-key caller)", () => {
    const h = getCorsHeaders("POST, OPTIONS");
    expect(h["Access-Control-Allow-Origin"]).toBe("*");
  });
});

describe("handleCorsOptions / applyCorsHeaders", () => {
  test("preflight reflects the app origin with credentials", () => {
    const res = handleCorsOptions("POST, OPTIONS", "https://localhost");
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe("https://localhost");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  test("applyCorsHeaders preserves the body + status and reflects the origin", async () => {
    const wrapped = applyCorsHeaders(
      new Response("event: done\n\n", {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
      "POST, OPTIONS",
      "https://localhost",
    );
    expect(wrapped.status).toBe(200);
    expect(wrapped.headers.get("content-type")).toBe("text/event-stream");
    expect(wrapped.headers.get("access-control-allow-origin")).toBe("https://localhost");
    await expect(wrapped.text()).resolves.toContain("event: done");
  });
});
