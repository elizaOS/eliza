/**
 * Coverage for hono-root-request.
 */
import { describe, expect, it } from "vitest";
import { fetchHonoRoot, toHonoRootRequest } from "./hono-root-request.js";

describe("hono-root-request", () => {
  it("rewrites pathname", () => {
    const req = new Request("https://example.com/api/foo?x=1");
    const out = toHonoRootRequest(req);
    expect(new URL(out.url).pathname).toBe("/");
    expect(new URL(out.url).search).toBe("?x=1");
  });
  it("preserves method", () => {
    const req = new Request("https://example.com/a", { method: "POST" });
    expect(toHonoRootRequest(req).method).toBe("POST");
  });
  it("fetchHonoRoot delegates", async () => {
    const app = { fetch: (r: Request) => Promise.resolve(new Response(r.url)) };
    const req = new Request("https://example.com/api");
    const res = await fetchHonoRoot(app as never, req);
    expect(await res.text()).toContain("/");
  });
});
