// @vitest-environment node

/**
 * Contract test for the REAL Shopify route parser (handleShopifyRoute in
 * routes.ts). It sets SHOPIFY_* env so the handler treats itself as configured,
 * stubs global fetch with REAL-SHAPED Shopify Admin GraphQL **2025-04** payloads
 * ({ data: { ... } }), and asserts the handler transforms each provider shape
 * into the flat DTOs the views consume. The payload shapes mirror the exact
 * selection sets in routes.ts and the Shopify Admin GraphQL 2025-04 schema:
 *   - shop.myshopifyDomain / plan.displayName / currencyCode
 *   - products.edges[].node.priceRangeV2.{min,max}VariantPrice.amount, featuredImage.url
 *   - orders.edges[].node.totalPriceSet.shopMoney + displayFinancial/FulfillmentStatus
 *     + lineItems.edges (length → lineItemCount)
 *   - inventory: products→variants→inventoryItem.inventoryLevels.edges + locations.isActive
 *     + "Default Title"→"" + zero-level fallback
 *   - customers: numberOfOrders (UnsignedInt64 string) → Number, amountSpent MoneyV2
 *
 * Runs the actual parser with no live creds.
 */

import type http from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleShopifyRoute } from "./routes";

interface CapturedResponse {
  status: number;
  body: unknown;
}

// Minimal http.ServerResponse double that captures what sendJson writes.
function makeRes(): { res: http.ServerResponse; captured: CapturedResponse } {
  const captured: CapturedResponse = { status: 0, body: undefined };
  const res = {
    headersSent: false,
    statusCode: 0,
    setHeader() {},
    end(payload?: string) {
      captured.status = (this as { statusCode: number }).statusCode;
      captured.body = payload ? JSON.parse(payload) : undefined;
      (this as { headersSent: boolean }).headersSent = true;
    },
  } as unknown as http.ServerResponse;
  return { res, captured };
}

function makeReq(url: string, body?: string): http.IncomingMessage {
  const handlers: Record<string, (chunk?: Buffer) => void> = {};
  const req = {
    url,
    on(event: string, cb: (chunk?: Buffer) => void) {
      handlers[event] = cb;
      // Drive the readBody promise synchronously on the next tick.
      if (event === "end") {
        queueMicrotask(() => {
          if (body !== undefined && handlers.data)
            handlers.data(Buffer.from(body));
          handlers.end?.();
        });
      }
      return this;
    },
  } as unknown as http.IncomingMessage;
  return req;
}

// Dispatch a GraphQL response by matching a distinctive token in the query.
function gqlResponse(data: unknown) {
  return new Response(JSON.stringify({ data }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function stubGraphql(routeData: {
  shop?: unknown;
  productsCount?: unknown;
  products?: unknown;
  orders?: unknown;
  ordersCount?: unknown;
  inventoryProducts?: unknown;
  locations?: unknown;
  customers?: unknown;
  customersCount?: unknown;
}) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      // The parser only ever POSTs to the Admin GraphQL endpoint.
      expect(String(url)).toContain("/admin/api/2025-04/graphql.json");
      const query = String(JSON.parse(String(init?.body ?? "{}")).query ?? "");

      // Order matters: the inventory query also matches "products(first", so it
      // must be checked before the generic products-list branch.
      if (query.includes("shop {")) {
        return gqlResponse({ shop: routeData.shop });
      }
      if (query.includes("inventoryLevels")) {
        return gqlResponse({
          products: routeData.inventoryProducts,
          locations: routeData.locations,
        });
      }
      if (query.includes("productsCount(query")) {
        return gqlResponse({ productsCount: routeData.productsCount });
      }
      if (query.includes("products(first")) {
        return gqlResponse({ products: routeData.products });
      }
      if (query.includes("orders(first")) {
        return gqlResponse({
          orders: routeData.orders,
          ordersCount: routeData.ordersCount,
        });
      }
      if (query.includes("customers(first")) {
        return gqlResponse({
          customers: routeData.customers,
          customersCount: routeData.customersCount,
        });
      }
      throw new Error(`unexpected query: ${query.slice(0, 80)}`);
    }),
  );
}

beforeEach(() => {
  process.env.SHOPIFY_STORE_DOMAIN = "eliza.myshopify.com";
  process.env.SHOPIFY_ACCESS_TOKEN = "shpat_test_token";
});

afterEach(() => {
  delete process.env.SHOPIFY_STORE_DOMAIN;
  delete process.env.SHOPIFY_ACCESS_TOKEN;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("handleShopifyRoute parser contract (Shopify Admin GraphQL 2025-04)", () => {
  it("status → flat shop DTO (domain=myshopifyDomain, plan=plan.displayName)", async () => {
    stubGraphql({
      shop: {
        name: "Eliza Store",
        myshopifyDomain: "eliza.myshopify.com",
        plan: { displayName: "Shopify Plus" },
        email: "ops@example.com",
        currencyCode: "USD",
      },
    });

    const { res, captured } = makeRes();
    const handled = await handleShopifyRoute(
      makeReq("/api/shopify/status"),
      res,
      "/api/shopify/status",
      "GET",
    );

    expect(handled).toBe(true);
    expect(captured.status).toBe(200);
    expect(captured.body).toMatchObject({
      connected: true,
      shop: {
        name: "Eliza Store",
        domain: "eliza.myshopify.com",
        plan: "Shopify Plus",
        email: "ops@example.com",
        currencyCode: "USD",
      },
    });
  });

  it("products → priceRange from priceRangeV2, imageUrl from featuredImage, total from productsCount", async () => {
    stubGraphql({
      productsCount: { count: 42 },
      products: {
        edges: [
          {
            cursor: "c1",
            node: {
              id: "gid://shopify/Product/1",
              title: "Terminal Hoodie",
              status: "ACTIVE",
              productType: "Apparel",
              vendor: "Eliza",
              totalInventory: 9,
              updatedAt: "2026-05-18T12:00:00Z",
              featuredImage: { url: "https://cdn.shopify.com/hoodie.png" },
              priceRangeV2: {
                minVariantPrice: { amount: "42.00" },
                maxVariantPrice: { amount: "58.00" },
              },
            },
          },
          {
            cursor: "c2",
            node: {
              id: "gid://shopify/Product/2",
              title: "Sticker",
              status: "DRAFT",
              productType: "Accessories",
              vendor: "Eliza",
              totalInventory: 0,
              updatedAt: "2026-05-18T12:00:00Z",
              featuredImage: null,
              priceRangeV2: {
                minVariantPrice: { amount: "3.00" },
                maxVariantPrice: { amount: "3.00" },
              },
            },
          },
        ],
        pageInfo: { hasNextPage: false, endCursor: "c2" },
      },
    });

    const { res, captured } = makeRes();
    await handleShopifyRoute(
      makeReq("/api/shopify/products?page=1&limit=20&q="),
      res,
      "/api/shopify/products",
      "GET",
    );

    expect(captured.status).toBe(200);
    const body = captured.body as {
      products: Array<Record<string, unknown>>;
      total: number;
      page: number;
    };
    expect(body.total).toBe(42);
    expect(body.page).toBe(1);
    expect(body.products[0]).toMatchObject({
      id: "gid://shopify/Product/1",
      title: "Terminal Hoodie",
      status: "ACTIVE",
      priceRange: { min: "42.00", max: "58.00" },
      imageUrl: "https://cdn.shopify.com/hoodie.png",
    });
    // featuredImage null → imageUrl null.
    expect(body.products[1].imageUrl).toBeNull();
    expect(body.products[1]).toMatchObject({
      priceRange: { min: "3.00", max: "3.00" },
    });
  });

  it("orders → totalPrice from totalPriceSet.shopMoney, statuses from display*, lineItemCount from lineItems.edges.length", async () => {
    stubGraphql({
      ordersCount: { count: 12 },
      orders: {
        edges: [
          {
            node: {
              id: "gid://shopify/Order/1",
              name: "#1001",
              email: "buyer@example.com",
              createdAt: "2026-05-18T12:00:00Z",
              displayFinancialStatus: "PAID",
              displayFulfillmentStatus: "UNFULFILLED",
              totalPriceSet: {
                shopMoney: { amount: "84.00", currencyCode: "USD" },
              },
              lineItems: { edges: [{ node: { id: "li-1" } }] },
            },
          },
          {
            node: {
              id: "gid://shopify/Order/2",
              name: "#1002",
              email: null,
              createdAt: "2026-05-19T12:00:00Z",
              displayFinancialStatus: "REFUNDED",
              displayFulfillmentStatus: null,
              totalPriceSet: {
                shopMoney: { amount: "12.50", currencyCode: "USD" },
              },
              lineItems: { edges: [] },
            },
          },
        ],
      },
    });

    const { res, captured } = makeRes();
    await handleShopifyRoute(
      makeReq("/api/shopify/orders?status=any&limit=20"),
      res,
      "/api/shopify/orders",
      "GET",
    );

    expect(captured.status).toBe(200);
    const body = captured.body as {
      orders: Array<Record<string, unknown>>;
      total: number;
    };
    expect(body.total).toBe(12);
    expect(body.orders[0]).toMatchObject({
      id: "gid://shopify/Order/1",
      name: "#1001",
      email: "buyer@example.com",
      totalPrice: "84.00",
      currencyCode: "USD",
      fulfillmentStatus: "UNFULFILLED",
      financialStatus: "PAID",
      lineItemCount: 1,
    });
    // null email → "" and null fulfillment passthrough; empty lineItems → 0.
    expect(body.orders[1]).toMatchObject({
      email: "",
      fulfillmentStatus: null,
      financialStatus: "REFUNDED",
      lineItemCount: 0,
    });
  });

  it("inventory → flattened per variant×location, Default Title→'', zero-level fallback, isActive locations only", async () => {
    stubGraphql({
      inventoryProducts: {
        edges: [
          {
            node: {
              title: "Terminal Hoodie",
              variants: {
                edges: [
                  {
                    node: {
                      id: "gid://shopify/ProductVariant/1",
                      title: "Black / M",
                      sku: "HOODIE-1",
                      inventoryItem: {
                        id: "gid://shopify/InventoryItem/1",
                        inventoryLevels: {
                          edges: [
                            {
                              node: {
                                available: 3,
                                location: {
                                  id: "gid://shopify/Location/1",
                                  name: "Main Warehouse",
                                },
                              },
                            },
                            {
                              node: {
                                available: 7,
                                location: {
                                  id: "gid://shopify/Location/2",
                                  name: "Outlet",
                                },
                              },
                            },
                          ],
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
          {
            node: {
              title: "Untracked Mug",
              variants: {
                edges: [
                  {
                    node: {
                      id: "gid://shopify/ProductVariant/2",
                      // "Default Title" must collapse to "".
                      title: "Default Title",
                      sku: "",
                      inventoryItem: {
                        id: "gid://shopify/InventoryItem/2",
                        // No inventory levels → zero-level fallback row.
                        inventoryLevels: { edges: [] },
                      },
                    },
                  },
                ],
              },
            },
          },
        ],
      },
      locations: {
        edges: [
          { node: { name: "Main Warehouse", isActive: true } },
          { node: { name: "Outlet", isActive: true } },
          { node: { name: "Closed Store", isActive: false } },
        ],
      },
    });

    const { res, captured } = makeRes();
    await handleShopifyRoute(
      makeReq("/api/shopify/inventory"),
      res,
      "/api/shopify/inventory",
      "GET",
    );

    expect(captured.status).toBe(200);
    const body = captured.body as {
      items: Array<Record<string, unknown>>;
      locations: string[];
    };
    // 2 levels for variant-1 + 1 fallback row for variant-2 = 3 items.
    expect(body.items.length).toBe(3);
    expect(body.items[0]).toMatchObject({
      id: "gid://shopify/InventoryItem/1",
      productTitle: "Terminal Hoodie",
      variantTitle: "Black / M",
      locationName: "Main Warehouse",
      available: 3,
      incoming: 0,
    });
    expect(body.items[1]).toMatchObject({
      locationName: "Outlet",
      available: 7,
    });
    // zero-level fallback row.
    expect(body.items[2]).toMatchObject({
      id: "gid://shopify/InventoryItem/2",
      variantTitle: "",
      locationId: null,
      locationName: "",
      available: 0,
    });
    // Only active locations surface.
    expect(body.locations).toEqual(["Main Warehouse", "Outlet"]);
  });

  it("customers → ordersCount=Number(numberOfOrders), totalSpent/currency from amountSpent MoneyV2", async () => {
    stubGraphql({
      customersCount: { count: 4 },
      customers: {
        edges: [
          {
            node: {
              id: "gid://shopify/Customer/1",
              firstName: "Grace",
              lastName: "Hopper",
              email: "grace@example.com",
              // 2025-04: numberOfOrders is UnsignedInt64 → serialized as a string.
              numberOfOrders: "7",
              amountSpent: { amount: "1234.50", currencyCode: "USD" },
              createdAt: "2026-01-02T00:00:00Z",
            },
          },
        ],
      },
    });

    const { res, captured } = makeRes();
    await handleShopifyRoute(
      makeReq("/api/shopify/customers?q=&limit=20"),
      res,
      "/api/shopify/customers",
      "GET",
    );

    expect(captured.status).toBe(200);
    const body = captured.body as {
      customers: Array<Record<string, unknown>>;
      total: number;
    };
    expect(body.total).toBe(4);
    expect(body.customers[0]).toMatchObject({
      id: "gid://shopify/Customer/1",
      firstName: "Grace",
      lastName: "Hopper",
      email: "grace@example.com",
      ordersCount: 7,
      totalSpent: "1234.50",
      currencyCode: "USD",
    });
    // String → number coercion is real, not a string.
    expect(typeof body.customers[0].ordersCount).toBe("number");
  });

  it("returns 404 for non-status routes when creds are unset", async () => {
    delete process.env.SHOPIFY_STORE_DOMAIN;
    delete process.env.SHOPIFY_ACCESS_TOKEN;

    const { res, captured } = makeRes();
    const handled = await handleShopifyRoute(
      makeReq("/api/shopify/products"),
      res,
      "/api/shopify/products",
      "GET",
    );
    expect(handled).toBe(true);
    expect(captured.status).toBe(404);
    expect(captured.body).toMatchObject({
      error: expect.stringContaining("Shopify not configured"),
    });
  });
});
