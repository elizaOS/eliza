/**
 * Exercise auth failure diagnostics through the real e2e HTTP client and a
 * deterministic local server. Injected failures prove evidence preservation,
 * not the cause of an intermittent Wrangler or application failure.
 */

import { expect, test } from "bun:test";
import { api } from "../test/e2e/_helpers/api";
import { expectAuthGate } from "../test/e2e/_helpers/auth-gate";

test("auth checks retain transport and application failures without replay or leaked headers", async () => {
  const savedBase = process.env.TEST_API_BASE_URL;
  let calls = 0;
  let status = 500;
  let body =
    "Error: Network connection lost.\n    at await service.fetch(request)";
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      calls++;
      expect(new URL(request.url).pathname).toBe("/api/quotas/usage");
      expect(request.headers.has("authorization")).toBe(false);
      return new Response(body, {
        status,
        headers: {
          "content-type": "text/plain",
          server: "workerd",
          "x-eliza-trace-id": "diagnostic-trace",
          "set-cookie": "private-session=do-not-log",
        },
      });
    },
  });
  process.env.TEST_API_BASE_URL = server.url.toString().replace(/\/$/, "");
  try {
    for (const failureBody of [
      body,
      JSON.stringify({ success: false, code: "internal_error" }),
    ]) {
      body = failureBody;
      const before = calls;
      const response = await api.get("/api/quotas/usage");
      let diagnostic: Error | undefined;
      try {
        await expectAuthGate(response, "GET /api/quotas/usage");
      } catch (error) {
        // error-policy:J1 inspect the assertion failure at the test boundary.
        if (!(error instanceof Error)) throw error;
        diagnostic = error;
      }
      expect(diagnostic).toBeInstanceOf(Error);
      expect(diagnostic?.message).toContain("got 500");
      expect(diagnostic?.message).toContain(JSON.stringify(failureBody));
      expect(diagnostic?.message).toContain("diagnostic-trace");
      expect(diagnostic?.message).not.toContain("private-session");
      expect(await response.text()).toBe(failureBody);
      expect(calls - before).toBe(1);
    }
    status = 401;
    body = "Unauthorized";
    const response = await api.get("/api/quotas/usage");
    await expectAuthGate(response, "GET /api/quotas/usage");
    expect(await response.text()).toBe(body);
  } finally {
    server.stop(true);
    if (savedBase === undefined) delete process.env.TEST_API_BASE_URL;
    else process.env.TEST_API_BASE_URL = savedBase;
  }
});
