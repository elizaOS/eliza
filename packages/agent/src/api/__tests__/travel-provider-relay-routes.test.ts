import type http from "node:http";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../cloud/validate-url.js", () => ({
  validateCloudBaseUrl: vi.fn(async () => null),
}));
vi.mock("@elizaos/agent/cloud/base-url", () => ({
  normalizeCloudSiteUrl: (value?: string) =>
    value?.replace(/\/+$/, "") || "https://www.elizacloud.ai",
}));
vi.mock("@elizaos/agent/cloud/validate-url", () => ({
  validateCloudBaseUrl: vi.fn(async () => null),
}));

import {
  handleTravelProviderRelayRoute,
  type TravelProviderRelayRouteState,
} from "../travel-provider-relay-routes.js";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_CLOUD_API_KEY = process.env.ELIZAOS_CLOUD_API_KEY;

function makeFetchMock(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  return vi.fn(impl);
}

function makeResponseCollector() {
  let body = "";
  const headers = new Map<string, string>();
  const res = {
    statusCode: 200,
    setHeader(name: string, value: string) {
      headers.set(name.toLowerCase(), value);
    },
    end(chunk?: string) {
      body = chunk ?? "";
    },
  } as unknown as http.ServerResponse;

  return {
    res,
    headers,
    readBody<T>() {
      return JSON.parse(body) as T;
    },
    getStatus() {
      return res.statusCode;
    },
  };
}

function makeReq(url: string, body?: unknown): http.IncomingMessage {
  const chunks =
    body === undefined ? [] : [Buffer.from(JSON.stringify(body), "utf-8")];
  const req = Readable.from(chunks) as http.IncomingMessage;
  req.url = url;
  return req;
}

function makeRuntimeWithCloudAuth(apiKey: string) {
  return {
    getService: (serviceType: string) =>
      serviceType === "CLOUD_AUTH"
        ? {
            isAuthenticated: () => true,
            getApiKey: () => apiKey,
          }
        : null,
  } satisfies NonNullable<TravelProviderRelayRouteState["runtime"]>;
}

describe("travel-provider relay route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.ELIZAOS_CLOUD_API_KEY;
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_CLOUD_API_KEY === undefined) {
      delete process.env.ELIZAOS_CLOUD_API_KEY;
    } else {
      process.env.ELIZAOS_CLOUD_API_KEY = ORIGINAL_CLOUD_API_KEY;
    }
  });

  it("returns 401 when no Eliza Cloud API key is available", async () => {
    const { res, readBody, getStatus } = makeResponseCollector();
    const state: TravelProviderRelayRouteState = {
      config: { cloud: { baseUrl: "https://www.elizacloud.ai" } },
      runtime: undefined,
    };
    const handled = await handleTravelProviderRelayRoute(
      makeReq("/api/cloud/travel-providers/provider-a/offer-requests", {
        data: {},
      }),
      res,
      "/api/cloud/travel-providers/provider-a/offer-requests",
      "POST",
      state,
    );
    expect(handled).toBe(true);
    expect(getStatus()).toBe(401);
    expect(readBody<{ error: string }>().error).toMatch(/Eliza Cloud/);
  });

  it("returns 404 for unknown travel-provider relay subpaths", async () => {
    const { res, readBody, getStatus } = makeResponseCollector();
    const state: TravelProviderRelayRouteState = {
      config: { cloud: { baseUrl: "https://www.elizacloud.ai" } },
      runtime: makeRuntimeWithCloudAuth("k"),
    };
    const handled = await handleTravelProviderRelayRoute(
      makeReq(
        "/api/cloud/travel-providers/provider-a/totally-bogus",
        undefined,
      ),
      res,
      "/api/cloud/travel-providers/provider-a/totally-bogus",
      "GET",
      state,
    );
    expect(handled).toBe(true);
    expect(getStatus()).toBe(404);
    expect(readBody<{ error: string }>().error).toMatch(/Unknown/);
  });

  it("forwards POST /offer-requests upstream with auth + service key headers", async () => {
    let capturedUrl = "";
    let capturedInit: RequestInit | undefined;
    const fetchMock = makeFetchMock(async (input, init) => {
      capturedUrl = String(input);
      capturedInit = init;
      return new Response(
        JSON.stringify({
          data: { id: "ofr_123", offers: [] },
          _meta: {
            cost: {
              total_usd: 0.05,
              creator_markup_usd: 0.02,
              platform_fee_usd: 0.01,
            },
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const { res, readBody, getStatus } = makeResponseCollector();
    const state: TravelProviderRelayRouteState = {
      config: {
        cloud: {
          baseUrl: "https://www.elizacloud.ai",
          serviceKey: "svc-key",
        },
      },
      runtime: makeRuntimeWithCloudAuth("user-session-key"),
    };
    const handled = await handleTravelProviderRelayRoute(
      makeReq("/api/cloud/travel-providers/provider-a/offer-requests", {
        data: { slices: [], passengers: [{ type: "adult" }] },
      }),
      res,
      "/api/cloud/travel-providers/provider-a/offer-requests",
      "POST",
      state,
    );

    expect(handled).toBe(true);
    expect(getStatus()).toBe(200);
    expect(capturedUrl).toBe(
      "https://www.elizacloud.ai/api/v1/provider-a/offer-requests",
    );
    const headers = (capturedInit?.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer user-session-key");
    expect(headers["X-Service-Key"]).toBe("svc-key");
    expect(capturedInit?.method).toBe("POST");

    const body = readBody<{
      data: { id: string };
      _meta: { cost: { total_usd: number } };
    }>();
    expect(body.data.id).toBe("ofr_123");
    expect(body._meta.cost.total_usd).toBe(0.05);
  });

  it("forwards GET /offers/:id upstream and propagates upstream status on failure", async () => {
    const fetchMock = makeFetchMock(async (input) => {
      expect(String(input)).toBe(
        "https://www.elizacloud.ai/api/v1/provider-a/offers/off_xyz",
      );
      return new Response(JSON.stringify({ error: "insufficient_credits" }), {
        status: 402,
        headers: { "Content-Type": "application/json" },
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const { res, readBody, getStatus } = makeResponseCollector();
    const state: TravelProviderRelayRouteState = {
      config: { cloud: { baseUrl: "https://www.elizacloud.ai" } },
      runtime: makeRuntimeWithCloudAuth("k"),
    };
    const handled = await handleTravelProviderRelayRoute(
      makeReq(
        "/api/cloud/travel-providers/provider-a/offers/off_xyz",
        undefined,
      ),
      res,
      "/api/cloud/travel-providers/provider-a/offers/off_xyz",
      "GET",
      state,
    );

    expect(handled).toBe(true);
    expect(getStatus()).toBe(402);
    expect(readBody<{ error: string }>().error).toBe("insufficient_credits");
  });

  it("forwards 402 verbatim with WWW-Authenticate x402 header for adapter parsing", async () => {
    const fetchMock = makeFetchMock(async () => {
      return new Response(
        JSON.stringify({
          paymentRequirements: [
            {
              amount: "1500000",
              asset: "USDC",
              network: "base",
              payTo: "0xabc",
              scheme: "exact",
              description: "Top up for travel booking",
            },
          ],
        }),
        {
          status: 402,
          headers: {
            "Content-Type": "application/json",
            "WWW-Authenticate":
              'x402 {"paymentRequirements":[{"amount":"1500000","asset":"USDC","network":"base","payTo":"0xabc","scheme":"exact"}]}',
          },
        },
      );
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const { res, headers, readBody, getStatus } = makeResponseCollector();
    const state: TravelProviderRelayRouteState = {
      config: { cloud: { baseUrl: "https://www.elizacloud.ai" } },
      runtime: makeRuntimeWithCloudAuth("k"),
    };
    const handled = await handleTravelProviderRelayRoute(
      makeReq(
        "/api/cloud/travel-providers/provider-a/offers/off_pay",
        undefined,
      ),
      res,
      "/api/cloud/travel-providers/provider-a/offers/off_pay",
      "GET",
      state,
    );

    expect(handled).toBe(true);
    expect(getStatus()).toBe(402);
    expect(headers.get("www-authenticate")).toMatch(/^x402 /);
    const body = readBody<{
      paymentRequirements: Array<{ asset: string }>;
    }>();
    expect(body.paymentRequirements[0]?.asset).toBe("USDC");
  });

  it("returns false (does not handle) for unrelated cloud paths", async () => {
    const { res } = makeResponseCollector();
    const state: TravelProviderRelayRouteState = {
      config: { cloud: { baseUrl: "https://www.elizacloud.ai" } },
      runtime: makeRuntimeWithCloudAuth("k"),
    };
    const handled = await handleTravelProviderRelayRoute(
      makeReq("/api/cloud/billing/summary", undefined),
      res,
      "/api/cloud/billing/summary",
      "GET",
      state,
    );
    expect(handled).toBe(false);
  });
});
