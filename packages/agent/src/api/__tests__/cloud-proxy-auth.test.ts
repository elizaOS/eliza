import type http from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../cloud/validate-url.js", () => ({
  validateCloudBaseUrl: vi.fn(async () => null),
}));

import {
  type CloudBillingRouteState,
  handleCloudBillingRoute,
} from "../cloud-billing-routes.js";
import {
  type CloudCompatRouteState,
  handleCloudCompatRoute,
} from "../cloud-compat-routes.js";
import {
  type CloudStatusRouteContext,
  handleCloudStatusRoutes,
} from "../cloud-status-routes.js";

const ORIGINAL_FETCH = globalThis.fetch;

function makeFetchMock(
  impl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
) {
  const fetchMock = vi.fn(impl);
  return Object.assign(
    fetchMock,
    typeof ORIGINAL_FETCH.preconnect === "function"
      ? { preconnect: ORIGINAL_FETCH.preconnect.bind(ORIGINAL_FETCH) }
      : {},
  );
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
  };
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
  } as unknown as CloudBillingRouteState["runtime"];
}

function makeRuntimeWithSavedKey(apiKey: string) {
  const runtime: Partial<NonNullable<CloudBillingRouteState["runtime"]>> = {
    getService: () => null,
    getSetting: (key: string) =>
      key === "ELIZAOS_CLOUD_API_KEY" ? apiKey : undefined,
  };
  return runtime as CloudBillingRouteState["runtime"];
}

describe("cloud proxy auth resolution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("uses the authenticated runtime api key for billing routes", async () => {
    const fetchMock = makeFetchMock(
      async (input: RequestInfo | URL, _init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/credits/summary")) {
          return new Response(
            JSON.stringify({
              success: true,
              organization: {
                creditBalance: 11.13,
                hasPaymentMethod: true,
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/api/crypto/status")) {
          return new Response(JSON.stringify({ enabled: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      },
    );
    globalThis.fetch = fetchMock;

    const { res, readBody } = makeResponseCollector();
    const state: CloudBillingRouteState = {
      config: {
        cloud: {
          baseUrl: "https://www.elizacloud.ai",
          serviceKey: "svc-key",
        },
      },
      runtime: makeRuntimeWithCloudAuth("runtime-session-key"),
    };

    const handled = await handleCloudBillingRoute(
      {
        url: "/api/cloud/billing/summary",
      } as http.IncomingMessage,
      res,
      "/api/cloud/billing/summary",
      "GET",
      state,
    );

    expect(handled).toBe(true);
    expect(readBody<{ balance: number; success: boolean }>()).toMatchObject({
      success: true,
      balance: 11.13,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init?.headers as Record<string, string>).Authorization).toBe(
        "Bearer runtime-session-key",
      );
      expect((init?.headers as Record<string, string>)["X-Service-Key"]).toBe(
        "svc-key",
      );
    }
  });

  it("uses the authenticated runtime api key for compat routes", async () => {
    const fetchMock = makeFetchMock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        expect(url).toBe(
          "https://www.elizacloud.ai/api/compat/agents?limit=10",
        );
        expect((init?.headers as Record<string, string>).Authorization).toBe(
          "Bearer runtime-session-key",
        );
        return new Response(
          JSON.stringify({
            success: true,
            data: [{ id: "agent-123", name: "Milady" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      },
    );
    globalThis.fetch = fetchMock;

    const { res, readBody } = makeResponseCollector();
    const state: CloudCompatRouteState = {
      config: {
        cloud: {
          baseUrl: "https://www.elizacloud.ai",
        },
      },
      runtime: makeRuntimeWithCloudAuth("runtime-session-key"),
    };

    const handled = await handleCloudCompatRoute(
      {
        url: "/api/cloud/compat/agents?limit=10",
      } as http.IncomingMessage,
      res,
      "/api/cloud/compat/agents",
      "GET",
      state,
    );

    expect(handled).toBe(true);
    expect(
      readBody<{ success: boolean; data: Array<{ id: string }> }>(),
    ).toEqual({
      success: true,
      data: [{ id: "agent-123", name: "Milady" }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses the runtime saved api key for billing routes before CLOUD_AUTH is ready", async () => {
    const fetchMock = makeFetchMock(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.endsWith("/api/v1/credits/summary")) {
          expect((init?.headers as Record<string, string>).Authorization).toBe(
            "Bearer runtime-setting-key",
          );
          return new Response(
            JSON.stringify({
              success: true,
              organization: {
                creditBalance: 11.13,
                hasPaymentMethod: true,
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }
        if (url.endsWith("/api/crypto/status")) {
          expect((init?.headers as Record<string, string>).Authorization).toBe(
            "Bearer runtime-setting-key",
          );
          return new Response(JSON.stringify({ enabled: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          });
        }
        throw new Error(`Unexpected fetch URL: ${url}`);
      },
    );
    globalThis.fetch = fetchMock;

    const { res, readBody } = makeResponseCollector();
    const state: CloudBillingRouteState = {
      config: {
        cloud: {
          baseUrl: "https://www.elizacloud.ai",
        },
      },
      runtime: makeRuntimeWithSavedKey("runtime-setting-key"),
    };

    const handled = await handleCloudBillingRoute(
      {
        url: "/api/cloud/billing/summary",
      } as http.IncomingMessage,
      res,
      "/api/cloud/billing/summary",
      "GET",
      state,
    );

    expect(handled).toBe(true);
    expect(readBody<{ success: boolean; balance: number }>()).toMatchObject({
      success: true,
      balance: 11.13,
    });
  });

  it("reports cloud as connected when the runtime has a saved api key before auth service init", async () => {
    const { res, readBody } = makeResponseCollector();
    const ctx: CloudStatusRouteContext = {
      req: {} as http.IncomingMessage,
      res,
      method: "GET",
      pathname: "/api/cloud/status",
      config: {},
      runtime: makeRuntimeWithSavedKey("runtime-setting-key"),
      json: (_res, data) => {
        res.end(JSON.stringify(data));
      },
    };

    const handled = await handleCloudStatusRoutes(ctx);

    expect(handled).toBe(true);
    expect(
      readBody<{
        connected: boolean;
        hasApiKey: boolean;
        reason?: string;
      }>(),
    ).toMatchObject({
      connected: true,
      hasApiKey: true,
      reason: "api_key_present_not_authenticated",
    });
  });
});
