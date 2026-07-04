import { PassThrough } from "node:stream";
import type { Route } from "@elizaos/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { elizaCloudRoutePlugin } from "../../src/plugin";
import { handleXRelayRoute } from "../../src/routes/x-relay-routes";

const ORIGINAL_ENV = { ...process.env };
const CACHED_REQUEST_BODY = Symbol.for("eliza.http.cachedRequestBody");

function createRequest(url: string, method = "GET") {
  const req = new PassThrough() as PassThrough & {
    url?: string;
    method?: string;
  };
  req.url = url;
  req.method = method;
  return req;
}

function createResponse() {
  const headers = new Map<string, string | number | readonly string[]>();
  const res = {
    statusCode: 200,
    body: "",
    setHeader(key: string, value: string | number | readonly string[]): void {
      headers.set(key.toLowerCase(), value);
    },
    getHeader(key: string): string | number | readonly string[] | undefined {
      return headers.get(key.toLowerCase());
    },
    end(body?: string | Buffer): void {
      res.body = Buffer.isBuffer(body) ? body.toString("utf-8") : (body ?? "");
    },
  };
  return res;
}

function pathnameOf(req: { url?: string }): string {
  return new URL(req.url ?? "/", "http://localhost").pathname;
}

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.unstubAllGlobals();
});

describe("handleXRelayRoute", () => {
  it("forwards GET X relay routes to the Cloud API with auth headers", async () => {
    process.env.NODE_ENV = "development";
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    const req = createRequest("/api/cloud/x/users/me?expansions=pinned_tweet_id");
    const res = createResponse();

    await expect(
      handleXRelayRoute(req as never, res as never, pathnameOf(req), "GET", {
        config: {
          cloud: {
            apiKey: "eliza_test",
            baseUrl: "https://cloud.example/",
            serviceKey: "service-key",
          },
        },
      })
    ).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloud.example/api/v1/x/users/me?expansions=pinned_tweet_id",
      expect.objectContaining({
        method: "GET",
        redirect: "manual",
        headers: expect.objectContaining({
          Authorization: "Bearer eliza_test",
          "X-Service-Key": "service-key",
        }),
      })
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ ok: true });
  });

  it("forwards a POST body read fresh from the request stream", async () => {
    process.env.NODE_ENV = "development";
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ id: "tweet-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const req = createRequest("/api/cloud/x/tweets", "POST");
    const res = createResponse();
    const payload = JSON.stringify({ text: "hello world" });
    req.end(payload);

    await expect(
      handleXRelayRoute(req as never, res as never, pathnameOf(req), "POST", {
        config: { cloud: { apiKey: "eliza_test", baseUrl: "https://cloud.example" } },
      })
    ).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloud.example/api/v1/x/tweets",
      expect.objectContaining({ method: "POST", body: payload })
    );
    expect(JSON.parse(res.body)).toEqual({ id: "tweet-1" });
  });

  it("forwards a POST body already cached by the plugin route pre-parse", async () => {
    process.env.NODE_ENV = "development";
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ id: "tweet-2" }));
    vi.stubGlobal("fetch", fetchMock);

    // Simulate attachJsonBodyIfPresent having already drained + cached the body
    // (the runtime plugin route system reads JSON POST bodies before handlers).
    const req = createRequest("/api/cloud/x/tweets", "POST");
    const payload = JSON.stringify({ text: "cached path" });
    (req as unknown as Record<symbol, unknown>)[CACHED_REQUEST_BODY] = Buffer.from(
      payload,
      "utf-8"
    );
    const res = createResponse();

    await handleXRelayRoute(req as never, res as never, pathnameOf(req), "POST", {
      config: { cloud: { apiKey: "eliza_test", baseUrl: "https://cloud.example" } },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://cloud.example/api/v1/x/tweets",
      expect.objectContaining({ method: "POST", body: payload })
    );
    expect(JSON.parse(res.body)).toEqual({ id: "tweet-2" });
  });

  it("preserves 402 payment-required responses and challenge headers", async () => {
    process.env.NODE_ENV = "development";
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(
        async () =>
          new Response("payment required", {
            status: 402,
            headers: {
              "content-type": "text/plain",
              "www-authenticate": "x402 challenge",
            },
          })
      )
    );

    const req = createRequest("/api/cloud/x/tweets", "POST");
    req.end(JSON.stringify({ text: "hi" }));
    const res = createResponse();

    await handleXRelayRoute(req as never, res as never, pathnameOf(req), "POST", {
      config: { cloud: { apiKey: "eliza_test", baseUrl: "https://cloud.example" } },
    });

    expect(res.statusCode).toBe(402);
    expect(res.getHeader("www-authenticate")).toBe("x402 challenge");
    expect(res.getHeader("content-type")).toBe("text/plain");
    expect(res.body).toBe("payment required");
  });

  it("returns 401 when not connected to Eliza Cloud", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const req = createRequest("/api/cloud/x/tweets");
    const res = createResponse();

    await handleXRelayRoute(req as never, res as never, pathnameOf(req), "GET", {
      config: {},
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({
      error: "Not connected to Eliza Cloud. Sign in to use X relays.",
    });
  });

  it("rejects unsupported methods with 405 before contacting the Cloud API", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const req = createRequest("/api/cloud/x/tweets", "DELETE");
    const res = createResponse();

    await expect(
      handleXRelayRoute(req as never, res as never, pathnameOf(req), "DELETE", {
        config: { cloud: { apiKey: "eliza_test", baseUrl: "https://cloud.example" } },
      })
    ).resolves.toBe(true);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(405);
    expect(JSON.parse(res.body)).toEqual({ error: "Unsupported X relay method" });
  });

  it("ignores non-X-relay paths", async () => {
    const req = createRequest("/api/cloud/billing/x402");
    const res = createResponse();

    await expect(
      handleXRelayRoute(req as never, res as never, pathnameOf(req), "GET", {
        config: {},
      })
    ).resolves.toBe(false);
  });
});

describe("elizaCloudRoutePlugin X relay registration", () => {
  it("registers /api/cloud/x/:path* for every method as a raw path", () => {
    const routes = (elizaCloudRoutePlugin.routes ?? []) as Route[];
    const xRoutes = routes.filter((route) => route.path === "/api/cloud/x/:path*");
    const methods = xRoutes.map((route) => route.type).sort();

    expect(methods).toEqual(["DELETE", "GET", "PATCH", "POST", "PUT"]);
    expect(xRoutes.every((route) => route.rawPath === true)).toBe(true);
    expect(xRoutes.every((route) => typeof route.handler === "function")).toBe(true);
  });
});
