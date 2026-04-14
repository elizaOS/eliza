/**
 * Unit tests for Shopify API routes and plugin registration.
 *
 * Tests the route handler directly with mock HTTP req/res objects.
 * External Shopify GraphQL calls are mocked via vi.stubGlobal.
 */

import http from "node:http";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { handleShopifyRoute } from "./routes";
import { shopifyPlugin } from "./plugin";
import { matchPluginRoutePath } from "@elizaos/agent/api/runtime-plugin-routes";

// ---------------------------------------------------------------------------
// Helpers: mock HTTP req/res
// ---------------------------------------------------------------------------

function mockReq(
  method: string,
  url: string,
  body?: string,
): http.IncomingMessage {
  const { Readable } = require("node:stream");
  const readable = new Readable();
  readable._read = () => {};
  if (body) {
    readable.push(body);
    readable.push(null);
  } else {
    readable.push(null);
  }
  readable.method = method;
  readable.url = url;
  readable.headers = { host: "localhost:31337" };
  return readable as http.IncomingMessage;
}

function mockRes(): http.ServerResponse & {
  _status: number;
  _headers: Record<string, string>;
  _body: string;
  _ended: boolean;
} {
  const res = {
    _status: 0,
    _headers: {} as Record<string, string>,
    _body: "",
    _ended: false,
    headersSent: false,
    statusCode: 200,
    setHeader(name: string, value: string) {
      res._headers[name.toLowerCase()] = value;
    },
    end(data?: string) {
      res._body = data ?? "";
      res._ended = true;
      res._status = res.statusCode;
    },
    writeHead(status: number, headers?: Record<string, string>) {
      res.statusCode = status;
      if (headers) {
        for (const [k, v] of Object.entries(headers)) {
          res._headers[k.toLowerCase()] = v;
        }
      }
    },
  };
  return res as unknown as ReturnType<typeof mockRes>;
}

function parseBody(res: ReturnType<typeof mockRes>): Record<string, unknown> {
  return JSON.parse(res._body) as Record<string, unknown>;
}

// Provide sendJson / sendJsonError
vi.mock("@elizaos/app-core", async (importOriginal) => {
  let original: Record<string, unknown> = {};
  try {
    original = (await importOriginal()) as Record<string, unknown>;
  } catch {
    // noop
  }
  return {
    ...original,
    sendJson: (
      res: http.ServerResponse,
      status: number,
      data: unknown,
    ) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(data));
    },
    sendJsonError: (
      res: http.ServerResponse,
      status: number,
      message: string,
    ) => {
      res.statusCode = status;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ error: message }));
    },
  };
});

// ---------------------------------------------------------------------------
// Plugin shape tests
// ---------------------------------------------------------------------------

describe("shopifyPlugin", () => {
  it("has the correct plugin name", () => {
    expect(shopifyPlugin.name).toBe("@elizaos/app-shopify");
  });

  it("exports routes array with all expected paths", () => {
    const paths = shopifyPlugin.routes!.map((r) => `${r.type} ${r.path}`);
    expect(paths).toContain("GET /api/shopify/status");
    expect(paths).toContain("GET /api/shopify/products");
    expect(paths).toContain("POST /api/shopify/products");
    expect(paths).toContain("GET /api/shopify/orders");
    expect(paths).toContain("GET /api/shopify/inventory");
    expect(paths).toContain("POST /api/shopify/inventory/:itemId/adjust");
    expect(paths).toContain("GET /api/shopify/customers");
  });

  it("all routes have rawPath: true", () => {
    for (const route of shopifyPlugin.routes!) {
      expect((route as Record<string, unknown>).rawPath).toBe(true);
    }
  });

  it("all routes have a handler function", () => {
    for (const route of shopifyPlugin.routes!) {
      expect(typeof route.handler).toBe("function");
    }
  });
});

// ---------------------------------------------------------------------------
// Route dispatch matching
// ---------------------------------------------------------------------------

describe("Shopify plugin route dispatch matching", () => {
  const routes = shopifyPlugin.routes!;

  it("matches GET /api/shopify/status", () => {
    const route = routes.find(
      (r) => r.type === "GET" && r.path === "/api/shopify/status",
    );
    expect(matchPluginRoutePath(route!.path, "/api/shopify/status")).toEqual({});
  });

  it("matches POST /api/shopify/inventory/:itemId/adjust with params", () => {
    const route = routes.find(
      (r) =>
        r.type === "POST" &&
        r.path === "/api/shopify/inventory/:itemId/adjust",
    );
    expect(
      matchPluginRoutePath(
        route!.path,
        "/api/shopify/inventory/gid%3A%2F%2Fshopify%2FInventoryItem%2F123/adjust",
      ),
    ).toEqual({ itemId: "gid://shopify/InventoryItem/123" });
  });

  it("does not match unrelated paths", () => {
    const route = routes.find(
      (r) => r.type === "GET" && r.path === "/api/shopify/status",
    );
    expect(matchPluginRoutePath(route!.path, "/api/vincent/status")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Route handler tests
// ---------------------------------------------------------------------------

describe("handleShopifyRoute", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.SHOPIFY_STORE_DOMAIN;
    delete process.env.SHOPIFY_ACCESS_TOKEN;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("GET /api/shopify/status (not configured)", () => {
    it("returns connected: false when env vars are missing", async () => {
      const req = mockReq("GET", "/api/shopify/status");
      const res = mockRes();

      const handled = await handleShopifyRoute(
        req,
        res,
        "/api/shopify/status",
        "GET",
      );

      expect(handled).toBe(true);
      const body = parseBody(res);
      expect(body.connected).toBe(false);
      expect(body.shop).toBeNull();
    });
  });

  describe("non-status routes when not configured", () => {
    it("returns 404 for products when not configured", async () => {
      const req = mockReq("GET", "/api/shopify/products");
      const res = mockRes();

      const handled = await handleShopifyRoute(
        req,
        res,
        "/api/shopify/products",
        "GET",
      );

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(404);
    });

    it("returns 404 for orders when not configured", async () => {
      const req = mockReq("GET", "/api/shopify/orders");
      const res = mockRes();

      const handled = await handleShopifyRoute(
        req,
        res,
        "/api/shopify/orders",
        "GET",
      );

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(404);
    });
  });

  describe("POST /api/shopify/products validation", () => {
    it("rejects missing title", async () => {
      process.env.SHOPIFY_STORE_DOMAIN = "test.myshopify.com";
      process.env.SHOPIFY_ACCESS_TOKEN = "shpat_test";

      const req = mockReq(
        "POST",
        "/api/shopify/products",
        JSON.stringify({ vendor: "Test" }),
      );
      const res = mockRes();

      // Mock fetch to avoid real API call
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn() as unknown as typeof fetch;

      const handled = await handleShopifyRoute(
        req,
        res,
        "/api/shopify/products",
        "POST",
      );

      globalThis.fetch = originalFetch;

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(400);
      const body = parseBody(res);
      expect(body.error).toContain("title");
    });
  });

  describe("unmatched routes", () => {
    it("returns false for non-shopify paths", async () => {
      const req = mockReq("GET", "/api/vincent/status");
      const res = mockRes();

      const handled = await handleShopifyRoute(
        req,
        res,
        "/api/vincent/status",
        "GET",
      );

      expect(handled).toBe(false);
    });
  });

  describe("GET /api/shopify/orders status filter validation", () => {
    it("rejects invalid order status filter", async () => {
      process.env.SHOPIFY_STORE_DOMAIN = "test.myshopify.com";
      process.env.SHOPIFY_ACCESS_TOKEN = "shpat_test";

      const req = mockReq("GET", "/api/shopify/orders?status=invalid");
      const res = mockRes();

      const handled = await handleShopifyRoute(
        req,
        res,
        "/api/shopify/orders",
        "GET",
      );

      expect(handled).toBe(true);
      expect(res.statusCode).toBe(400);
      const body = parseBody(res);
      expect(body.error).toContain("Unsupported order status");
    });
  });
});
