import { describe, test, expect } from "bun:test";
import { nodeRoutes } from "../../../src/routes/nodes";
import { createMockRuntime } from "../../helpers/mockRuntime";
import type { RouteRequest, RouteResponse } from "@elizaos/core";

function createRouteRequest(overrides?: Partial<RouteRequest>): RouteRequest {
  return {
    body: undefined,
    params: {},
    query: {},
    headers: {},
    method: "GET",
    ...overrides,
  };
}

function createRouteResponse(): {
  res: RouteResponse;
  getResult: () => { status: number; body: unknown };
} {
  let status = 200;
  let body: unknown;
  const res: RouteResponse = {
    status(code: number) {
      status = code;
      return res;
    },
    json(data: unknown) {
      body = data;
      return res;
    },
    send(data: unknown) {
      body = data;
      return res;
    },
    end() {
      return res;
    },
  };
  return { res, getResult: () => ({ status, body }) };
}

// Routes: [0] = /nodes/available, [1] = /nodes/:type, [2] = /nodes
const availableHandler = nodeRoutes[0].handler!;
const getNodeHandler = nodeRoutes[1].handler!;
const searchHandler = nodeRoutes[2].handler!;

const runtime = createMockRuntime();

describe("GET /nodes", () => {
  test("returns 400 when q parameter is missing", async () => {
    const req = createRouteRequest({ query: {} });
    const { res, getResult } = createRouteResponse();

    await searchHandler(req, res, runtime);

    expect(getResult().status).toBe(400);
  });

  test("returns search results for supported HTTP keyword", async () => {
    const req = createRouteRequest({ query: { q: "http" } });
    const { res, getResult } = createRouteResponse();

    await searchHandler(req, res, runtime);

    const { status, body } = getResult();
    expect(status).toBe(200);
    const data = body as {
      success: boolean;
      data: Array<{ name: string; score: number; matchReason: string }>;
    };
    expect(data.success).toBe(true);
    expect(data.data.length).toBeGreaterThan(0);
    expect(data.data[0].name).toBe("p1p3s-nodes-base.httpRequest");
    // Search results include score and matchReason
    expect(typeof data.data[0].score).toBe("number");
    expect(typeof data.data[0].matchReason).toBe("string");
  });

  test("respects limit parameter", async () => {
    const req = createRouteRequest({ query: { q: "send", limit: "3" } });
    const { res, getResult } = createRouteResponse();

    await searchHandler(req, res, runtime);

    const data = getResult().body as { data: unknown[] };
    expect(data.data.length).toBeLessThanOrEqual(3);
  });

  test("handles comma-separated keywords", async () => {
    const req = createRouteRequest({ query: { q: "http,set" } });
    const { res, getResult } = createRouteResponse();

    await searchHandler(req, res, runtime);

    const data = getResult().body as { success: boolean; data: unknown[] };
    expect(data.success).toBe(true);
    expect(data.data.length).toBeGreaterThan(0);
  });
});

describe("GET /nodes/:type", () => {
  test("returns node definition for valid type", async () => {
    const req = createRouteRequest({
      params: { type: "p1p3s-nodes-base.httpRequest" },
    });
    const { res, getResult } = createRouteResponse();

    await getNodeHandler(req, res, runtime);

    const { status, body } = getResult();
    expect(status).toBe(200);
    const data = body as {
      success: boolean;
      data: { name: string; properties: unknown[] };
    };
    expect(data.success).toBe(true);
    expect(data.data.name).toBe("p1p3s-nodes-base.httpRequest");
    expect(data.data.properties.length).toBeGreaterThan(0);
  });

  test("returns 404 for unknown node type", async () => {
    const req = createRouteRequest({
      params: { type: "p1p3s-nodes-base.nonexistentNode12345" },
    });
    const { res, getResult } = createRouteResponse();

    await getNodeHandler(req, res, runtime);

    expect(getResult().status).toBe(404);
  });

  test("returns 400 when type param is missing", async () => {
    const req = createRouteRequest({ params: {} });
    const { res, getResult } = createRouteResponse();

    await getNodeHandler(req, res, runtime);

    expect(getResult().status).toBe(400);
  });
});

describe("GET /nodes/available", () => {
  test("returns categorized nodes without credential bridge", async () => {
    const req = createRouteRequest();
    const { res, getResult } = createRouteResponse();

    await availableHandler(req, res, runtime);

    const { status, body } = getResult();
    expect(status).toBe(200);
    const data = body as {
      success: boolean;
      data: {
        supported: Array<{ name: string }>;
        unsupported: unknown[];
        utility: Array<{ name: string }>;
      };
    };
    expect(data.success).toBe(true);
    expect(data.data.supported.length).toBeGreaterThan(0);
    expect(data.data.utility.length).toBeGreaterThan(0);
    // Catalog nodes should NOT have score/matchReason
    const first = data.data.utility[0] as Record<string, unknown>;
    expect(first.score).toBeUndefined();
    expect(first.matchReason).toBeUndefined();
  });

  test("credential bridge path keeps utility-only embedded catalog available", async () => {
    const runtimeWithBridge = createMockRuntime({
      services: {
        workflow_credential_provider: {
          resolve: () => Promise.resolve(null),
          checkCredentialTypes: (types: string[]) => ({
            supported: types,
            unsupported: [],
          }),
        },
      },
    });

    const req = createRouteRequest();
    const { res, getResult } = createRouteResponse();

    await availableHandler(req, res, runtimeWithBridge);

    const { body } = getResult();
    const data = body as {
      data: {
        supported: Array<{ name: string }>;
        unsupported: Array<{ name: string; missingCredential?: string }>;
        utility: unknown[];
      };
    };
    expect(data.data.supported.length).toBeGreaterThan(0);
    expect(data.data.unsupported).toEqual([]);
    expect(data.data.utility.length).toBeGreaterThan(0);
  });
});
