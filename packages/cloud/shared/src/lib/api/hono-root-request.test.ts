import { describe, expect, it, vi } from "vitest";
import { fetchHonoRoot, toHonoRootRequest } from "./hono-root-request.js";

describe("hono-root-request", () => {
  it("rewrites pathname to root", () => {
    const req = new Request("https://example.com/api/foo?x=1");
    const rooted = toHonoRootRequest(req);
    expect(new URL(rooted.url).pathname).toBe("/");
    expect(new URL(rooted.url).search).toBe("?x=1");
  });

  it("fetchHonoRoot delegates to app", async () => {
    const app = { fetch: vi.fn().mockResolvedValue(new Response("ok")) };
    const req = new Request("https://example.com/some/path");
    const res = await fetchHonoRoot(app, req);
    expect(app.fetch).toHaveBeenCalled();
    const calledReq = app.fetch.mock.calls[0][0] as Request;
    expect(new URL(calledReq.url).pathname).toBe("/");
    expect(await (res as Response).text()).toBe("ok");
  });
});
