/** Verifies response security headers through real Hono requests, including loopback URL parsing. */
import { afterEach, expect, test } from "bun:test";
import { Hono } from "hono";
import { securityHeaders } from "../api/src/middleware/security-headers";

const previous = process.env.STEWARD_HSTS_DISABLED;
afterEach(() => {
  if (previous === undefined) delete process.env.STEWARD_HSTS_DISABLED;
  else process.env.STEWARD_HSTS_DISABLED = previous;
});

test.each([
  ["http://localhost:8787/", false],
  ["http://127.0.0.1:8787/", false],
  ["http://[::1]:8787/", false],
  ["https://login.example.test/", true],
])(
  "applies HSTS according to the parsed request URL %s",
  async (url, enabled) => {
    delete process.env.STEWARD_HSTS_DISABLED;
    const app = new Hono();
    app.use(securityHeaders);
    app.get("/", (c) => c.text("healthy"));
    const response = await app.request(url, { headers: { Host: new URL(url).host } });
    expect(await response.text()).toBe("healthy");
    expect(response.headers.has("Strict-Transport-Security")).toBe(enabled);
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  },
);
