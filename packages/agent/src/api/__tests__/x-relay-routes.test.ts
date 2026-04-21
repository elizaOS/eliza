import type http from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../cloud/validate-url.js", () => ({
  validateCloudBaseUrl: vi.fn(async () => null),
}));

import { handleXRelayRoute, type XRelayRouteState } from "../x-relay-routes.js";

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
  const handlers = new Map<string, Array<(arg?: unknown) => void>>();
  const req = {
    url,
    on(event: string, fn: (arg?: unknown) => void) {
      const list = handlers.get(event) ?? [];
      list.push(fn);
      handlers.set(event, list);
      return req;
    },
  } as unknown as http.IncomingMessage;

  setImmediate(() => {
    if (body !== undefined) {
      const buf = Buffer.from(JSON.stringify(body), "utf-8");
      handlers.get("data")?.forEach((fn) => fn(buf));
    }
    handlers.get("end")?.forEach((fn) => fn());
  });

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
  } satisfies NonNullable<XRelayRouteState["runtime"]>;
}

describe("X relay route", () => {
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
    const state: XRelayRouteState = {
      config: { cloud: { baseUrl: "https://www.elizacloud.ai" } },
      runtime: undefined,
    };
    const handled = await handleXRelayRoute(
      makeReq("/api/cloud/x/status"),
      res,
      "/api/cloud/x/status",
      "GET",
      state,
    );
    expect(handled).toBe(true);
    expect(getStatus()).toBe(401);
    expect(readBody<{ error: string }>().error).toMatch(/X relays/);
  });

  it("preserves upstream 402 responses and x402 headers", async () => {
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
              description: "Top up for X relay",
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
    const state: XRelayRouteState = {
      config: { cloud: { baseUrl: "https://www.elizacloud.ai" } },
      runtime: makeRuntimeWithCloudAuth("k"),
    };
    const handled = await handleXRelayRoute(
      makeReq("/api/cloud/x/posts", { confirmSend: true, text: "hello" }),
      res,
      "/api/cloud/x/posts",
      "POST",
      state,
    );

    expect(handled).toBe(true);
    expect(getStatus()).toBe(402);
    expect(headers.get("www-authenticate")).toMatch(/^x402 /);
    expect(
      readBody<{ paymentRequirements: Array<{ amount: string }> }>()
        .paymentRequirements[0].amount,
    ).toBe("1500000");
  });
});
