import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleTravelProviderRelayRoute } from "../../src/routes/travel-provider-relay-routes";

const ORIGINAL_ENV = { ...process.env };

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

describe("handleTravelProviderRelayRoute", () => {
  it("forwards supported travel-provider routes to the Cloud API", async () => {
    process.env.NODE_ENV = "development";
    const fetchMock = vi.fn<typeof fetch>(async () => Response.json({ id: "offer-1" }));
    vi.stubGlobal("fetch", fetchMock);

    const req = createRequest("/api/cloud/travel-providers/duffel/offers/off_123?include=details");
    const res = createResponse();

    await expect(
      handleTravelProviderRelayRoute(req as never, res as never, pathnameOf(req), "GET", {
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
      "https://cloud.example/api/v1/duffel/offers/off_123?include=details",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Bearer eliza_test",
          "X-Service-Key": "service-key",
        }),
      })
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ id: "offer-1" });
  });

  it("preserves payment-required responses and challenge headers", async () => {
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

    const req = createRequest("/api/cloud/travel-providers/duffel/orders/order_1");
    const res = createResponse();

    await handleTravelProviderRelayRoute(req as never, res as never, pathnameOf(req), "GET", {
      config: {
        cloud: {
          apiKey: "eliza_test",
          baseUrl: "https://cloud.example",
        },
      },
    });

    expect(res.statusCode).toBe(402);
    expect(res.getHeader("www-authenticate")).toBe("x402 challenge");
    expect(res.body).toBe("payment required");
  });

  it("handles relay paths without Cloud auth before fetching", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const req = createRequest("/api/cloud/travel-providers/duffel/offers/off_123");
    const res = createResponse();

    await handleTravelProviderRelayRoute(req as never, res as never, pathnameOf(req), "GET", {
      config: {},
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body)).toEqual({
      error: "Not connected to Eliza Cloud. Sign in to use travel search.",
    });
  });

  it("ignores non-relay paths", async () => {
    const req = createRequest("/api/lifeops/travel");
    const res = createResponse();

    await expect(
      handleTravelProviderRelayRoute(req as never, res as never, pathnameOf(req), "GET", {
        config: {},
      })
    ).resolves.toBe(false);
  });
});
