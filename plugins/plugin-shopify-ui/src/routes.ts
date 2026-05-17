/**
 * Shopify dashboard API routes.
 *
 * GET  /api/shopify/status
 * GET  /api/shopify/products?page=N&limit=N&q=Q
 * POST /api/shopify/products                         body: { title, vendor?, productType?, price? }
 * GET  /api/shopify/orders?status=S&limit=N
 * GET  /api/shopify/inventory
 * POST /api/shopify/inventory/:itemId/adjust         body: { delta, locationId? }
 * GET  /api/shopify/customers?q=Q&limit=N
 *
 * Credentials are read from process.env:
 *   SHOPIFY_STORE_DOMAIN  — e.g. mystore.myshopify.com
 *   SHOPIFY_ACCESS_TOKEN  — Shopify Admin API access token
 */

import type http from "node:http";
import { sendJson, sendJsonError } from "@elizaos/app-core";
import { logger } from "@elizaos/core";

const API_VERSION = "2025-04";
const ORDER_STATUS_FILTER_VALUES = [
  "any",
  "paid",
  "pending",
  "refunded",
  "partially_refunded",
] as const;
const ORDER_STATUS_FILTERS = new Set<string>(ORDER_STATUS_FILTER_VALUES);

/* ── Config resolution ─────────────────────────────────────────────── */

interface ShopifyConfig {
  storeDomain: string;
  accessToken: string;
}

function resolveShopifyConfig(): ShopifyConfig | null {
  const storeDomain = process.env.SHOPIFY_STORE_DOMAIN?.trim() ?? null;
  const accessToken = process.env.SHOPIFY_ACCESS_TOKEN?.trim() ?? null;
  if (!storeDomain || !accessToken) return null;
  return { storeDomain, accessToken };
}

/* ── GraphQL helper ────────────────────────────────────────────────── */

async function shopifyGql<T>(
  config: ShopifyConfig,
  query: string,
  variables?: Record<string, unknown>,
): Promise<T> {
  const domain = config.storeDomain
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  const url = `https://${domain}/admin/api/${API_VERSION}/graphql.json`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": config.accessToken,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`Shopify API ${resp.status}: ${text.slice(0, 200)}`);
  }

  const json = (await resp.json()) as {
    data?: T;
    errors?: Array<{ message: string }>;
  };
  if (json.errors?.length) {
    throw new Error(
      `Shopify GraphQL: ${json.errors.map((e) => e.message).join(", ")}`,
    );
  }
  return json.data as T;
}

/* ── Route handler ─────────────────────────────────────────────────── */

export async function handleShopifyRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  method: string,
): Promise<boolean> {
  if (!pathname.startsWith("/api/shopify")) return false;

  const config = resolveShopifyConfig();

  // ── GET /api/shopify/status ──────────────────────────────────────
  if (method === "GET" && pathname === "/api/shopify/status") {
    if (!config) {
      sendJson(res, 200, { connected: false, shop: null });
      return true;
    }
    try {
      const data = await shopifyGql<{
        shop: {
          name: string;
          myshopifyDomain: string;
          plan: { displayName: string };
          email: string;
          currencyCode: string;
          productsCount?: { count: number };
        };
      }>(
        config,
        `{ shop { name myshopifyDomain plan { displayName } email currencyCode } }`,
      );
      sendJson(res, 200, {
        connected: true,
        shop: {
          name: data.shop.name,
          domain: data.shop.myshopifyDomain,
          plan: data.shop.plan.displayName,
          email: data.shop.email,
          currencyCode: data.shop.currencyCode,
          ...(typeof data.shop.productsCount?.count === "number"
            ? { productCount: data.shop.productsCount.count }
            : {}),
        },
      });
    } catch (err) {
      logger.error(
        `[shopify/status] ${err instanceof Error ? err.message : String(err)}`,
      );
      sendJson(res, 200, {
        connected: false,
        shop: null,
        error: err instanceof Error ? err.message : "Connection failed",
      });
    }
    return true;
  }

  // All routes below require valid Shopify credentials.
  if (!config) {
    sendJsonError(
      res,
      404,
      "Shopify not configured (SHOPIFY_STORE_DOMAIN / SHOPIFY_ACCESS_TOKEN not set)",
    );
    return true;
  }

  // ── GET /api/shopify/products ────────────────────────────────────
  if (method === "GET" && pathname === "/api/shopify/products") {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const page = Math.max(1, Number(url.searchParams.get("page") ?? "1"));
      const limit = Math.min(
        50,
        Math.max(1, Number(url.searchParams.get("limit") ?? "20")),
      );
      const search = url.searchParams.get("q")?.trim() || null;
      const countData = await shopifyGql<{
        productsCount: { count: number };
      }>(
        config,
        `query CountProducts($query: String) {
          productsCount(query: $query) { count }
        }`,
        { query: search },
      );

      let after: string | null = null;
      let pageProducts: Array<{
        cursor: string;
        node: {
          id: string;
          title: string;
          status: string;
          productType: string;
          vendor: string;
          totalInventory: number;
          updatedAt: string;
          featuredImage: { url: string } | null;
          priceRangeV2: {
            minVariantPrice: { amount: string };
            maxVariantPrice: { amount: string };
          };
        };
      }> = [];
      type ShopifyProductsPageResponse = {
        products: {
          edges: Array<{
            cursor: string;
            node: {
              id: string;
              title: string;
              status: string;
              productType: string;
              vendor: string;
              totalInventory: number;
              updatedAt: string;
              featuredImage: { url: string } | null;
              priceRangeV2: {
                minVariantPrice: { amount: string };
                maxVariantPrice: { amount: string };
              };
            };
          }>;
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
        };
      };

      for (let currentPage = 1; currentPage <= page; currentPage++) {
        const data: ShopifyProductsPageResponse =
          await shopifyGql<ShopifyProductsPageResponse>(
            config,
            `query ListProductsPage($first: Int!, $after: String, $query: String) {
            products(first: $first, after: $after, query: $query, sortKey: TITLE) {
              edges {
                cursor
                node {
                  id title status productType vendor totalInventory updatedAt
                  featuredImage { url }
                  priceRangeV2 { minVariantPrice { amount } maxVariantPrice { amount } }
                }
              }
              pageInfo { hasNextPage endCursor }
            }
          }`,
            {
              first: limit,
              after,
              query: search,
            },
          );

        if (currentPage === page) {
          pageProducts = data.products.edges;
          break;
        }

        if (
          !data.products.pageInfo.hasNextPage ||
          !data.products.pageInfo.endCursor
        ) {
          pageProducts = [];
          break;
        }

        after = data.products.pageInfo.endCursor;
      }

      const products = pageProducts.map((edge) => ({
        id: edge.node.id,
        title: edge.node.title,
        status: edge.node.status as "ACTIVE" | "DRAFT" | "ARCHIVED",
        productType: edge.node.productType,
        vendor: edge.node.vendor,
        totalInventory: edge.node.totalInventory,
        priceRange: {
          min: edge.node.priceRangeV2.minVariantPrice.amount,
          max: edge.node.priceRangeV2.maxVariantPrice.amount,
        },
        imageUrl: edge.node.featuredImage?.url ?? null,
        updatedAt: edge.node.updatedAt,
      }));

      sendJson(res, 200, {
        products,
        total: countData.productsCount.count,
        page,
        pageSize: limit,
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to fetch products";
      logger.error(
        `[shopify/products] ${err instanceof Error ? err.message : String(err)}`,
      );
      sendJsonError(res, 500, message);
    }
    return true;
  }

  // ── POST /api/shopify/products ───────────────────────────────────
  if (method === "POST" && pathname === "/api/shopify/products") {
    try {
      const raw = await readBody(req);
      const input = JSON.parse(raw) as {
        title?: string;
        productType?: string;
        vendor?: string;
        price?: string;
      };
      if (!input.title?.trim()) {
        sendJsonError(res, 400, "title is required");
        return true;
      }

      const data = await shopifyGql<{
        productCreate: {
          product: {
            id: string;
            title: string;
            status: string;
            productType: string;
            vendor: string;
            totalInventory: number;
            updatedAt: string;
            featuredImage: { url: string } | null;
          } | null;
          userErrors: Array<{ field: string[]; message: string }>;
        };
      }>(
        config,
        `mutation CreateProduct($input: ProductInput!) {
          productCreate(input: $input) {
            product {
              id
              title
              status
              productType
              vendor
              totalInventory
              updatedAt
              featuredImage { url }
            }
            userErrors { field message }
          }
        }`,
        {
          input: {
            title: input.title.trim(),
            productType: input.productType?.trim() ?? "",
            vendor: input.vendor?.trim() ?? "",
            status: "DRAFT",
          },
        },
      );

      if (data.productCreate.userErrors.length) {
        sendJsonError(
          res,
          422,
          data.productCreate.userErrors
            .map((e) => `${e.field.join(".")}: ${e.message}`)
            .join("; "),
        );
        return true;
      }

      const product = data.productCreate.product;
      if (!product) {
        sendJsonError(res, 500, "Product create returned no product");
        return true;
      }

      sendJson(res, 201, {
        id: product.id,
        title: product.title,
        status: product.status,
        productType: product.productType,
        vendor: product.vendor,
        totalInventory: product.totalInventory,
        updatedAt: product.updatedAt,
        imageUrl: product.featuredImage?.url ?? null,
        priceRange: {
          min: input.price ?? "0.00",
          max: input.price ?? "0.00",
        },
      });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to create product";
      logger.error(
        `[shopify/products/create] ${err instanceof Error ? err.message : String(err)}`,
      );
      sendJsonError(res, 500, message);
    }
    return true;
  }

  // ── GET /api/shopify/orders ──────────────────────────────────────
  if (method === "GET" && pathname === "/api/shopify/orders") {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const limit = Math.min(
        50,
        Math.max(1, Number(url.searchParams.get("limit") ?? "20")),
      );
      const status = (url.searchParams.get("status") ?? "any")
        .trim()
        .toLowerCase();
      if (!ORDER_STATUS_FILTERS.has(status)) {
        sendJsonError(res, 400, `Unsupported order status filter: ${status}`);
        return true;
      }
      const queryFilter =
        status !== "any" ? `financial_status:${status}` : null;

      const data = await shopifyGql<{
        orders: {
          edges: Array<{
            node: {
              id: string;
              name: string;
              email: string;
              createdAt: string;
              displayFinancialStatus: string;
              displayFulfillmentStatus: string | null;
              totalPriceSet: {
                shopMoney: { amount: string; currencyCode: string };
              };
              lineItems: { edges: Array<unknown> };
            };
          }>;
        };
        ordersCount: { count: number };
      }>(
        config,
        `query ListOrders($first: Int!, $query: String) {
          orders(first: $first, query: $query, sortKey: CREATED_AT, reverse: true) {
            edges {
              node {
                id name email createdAt
                displayFinancialStatus displayFulfillmentStatus
                totalPriceSet { shopMoney { amount currencyCode } }
                lineItems(first: 1) { edges { node { id } } }
              }
            }
          }
          ordersCount { count }
        }`,
        { first: limit, query: queryFilter },
      );

      const orders = data.orders.edges.map((edge) => ({
        id: edge.node.id,
        name: edge.node.name,
        email: edge.node.email ?? "",
        totalPrice: edge.node.totalPriceSet.shopMoney.amount,
        currencyCode: edge.node.totalPriceSet.shopMoney.currencyCode,
        fulfillmentStatus: edge.node.displayFulfillmentStatus as
          | "FULFILLED"
          | "UNFULFILLED"
          | "PARTIALLY_FULFILLED"
          | null,
        financialStatus: edge.node.displayFinancialStatus as
          | "PAID"
          | "PENDING"
          | "REFUNDED"
          | "PARTIALLY_REFUNDED",
        createdAt: edge.node.createdAt,
        lineItemCount: edge.node.lineItems.edges.length,
      }));

      sendJson(res, 200, { orders, total: data.ordersCount.count });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to fetch orders";
      logger.error(
        `[shopify/orders] ${err instanceof Error ? err.message : String(err)}`,
      );
      sendJsonError(res, 500, message);
    }
    return true;
  }

  // ── GET /api/shopify/inventory ───────────────────────────────────
  if (method === "GET" && pathname === "/api/shopify/inventory") {
    try {
      const data = await shopifyGql<{
        products: {
          edges: Array<{
            node: {
              title: string;
              variants: {
                edges: Array<{
                  node: {
                    id: string;
                    title: string;
                    sku: string;
                    inventoryItem: {
                      id: string;
                      inventoryLevels: {
                        edges: Array<{
                          node: {
                            available: number;
                            location: { id: string; name: string };
                          };
                        }>;
                      };
                    };
                  };
                }>;
              };
            };
          }>;
        };
        locations: {
          edges: Array<{ node: { name: string; isActive: boolean } }>;
        };
      }>(
        config,
        `{
          products(first: 50) {
            edges {
              node {
                title
                variants(first: 10) {
                  edges {
                    node {
                      id title sku
                      inventoryItem {
                        id
                        inventoryLevels(first: 10) {
                          edges { node { available location { id name } } }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
          locations(first: 20) {
            edges { node { name isActive } }
          }
        }`,
      );

      const items: Array<{
        id: string;
        sku: string;
        productTitle: string;
        variantTitle: string;
        locationId: string | null;
        locationName: string;
        available: number;
        incoming: number;
      }> = [];

      for (const productEdge of data.products.edges) {
        for (const variantEdge of productEdge.node.variants.edges) {
          const variant = variantEdge.node;
          const levels = variant.inventoryItem.inventoryLevels.edges;
          if (levels.length === 0) {
            items.push({
              id: variant.inventoryItem.id,
              sku: variant.sku ?? "",
              productTitle: productEdge.node.title,
              variantTitle:
                variant.title === "Default Title" ? "" : variant.title,
              locationId: null,
              locationName: "",
              available: 0,
              incoming: 0,
            });
            continue;
          }

          for (const levelEdge of levels) {
            items.push({
              id: variant.inventoryItem.id,
              sku: variant.sku ?? "",
              productTitle: productEdge.node.title,
              variantTitle:
                variant.title === "Default Title" ? "" : variant.title,
              locationId: levelEdge.node.location.id,
              locationName: levelEdge.node.location.name,
              available: levelEdge.node.available,
              incoming: 0,
            });
          }
        }
      }

      const locations = data.locations.edges
        .filter((edge) => edge.node.isActive)
        .map((edge) => edge.node.name);

      sendJson(res, 200, { items, locations });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to fetch inventory";
      logger.error(
        `[shopify/inventory] ${err instanceof Error ? err.message : String(err)}`,
      );
      sendJsonError(res, 500, message);
    }
    return true;
  }

  // ── POST /api/shopify/inventory/:itemId/adjust ──────────────────
  const adjustMatch = pathname.match(
    /^\/api\/shopify\/inventory\/(.+)\/adjust$/,
  );
  if (adjustMatch && method === "POST") {
    try {
      const raw = await readBody(req);
      const body = JSON.parse(raw) as {
        delta?: number;
        locationId?: string | null;
      };
      const delta = Number(body.delta);
      if (!Number.isInteger(delta) || delta === 0) {
        sendJsonError(res, 400, "delta must be a non-zero integer");
        return true;
      }

      const inventoryItemId = adjustMatch[1];
      const requestedLocationId =
        typeof body.locationId === "string" && body.locationId.trim()
          ? body.locationId.trim()
          : null;
      const itemData = await shopifyGql<{
        inventoryItem: {
          id: string;
          inventoryLevels: {
            edges: Array<{
              node: {
                id: string;
                location: { id: string; name: string };
              };
            }>;
          };
        } | null;
      }>(
        config,
        `query GetInventoryItem($id: ID!) {
          inventoryItem(id: $id) {
            id
            inventoryLevels(first: 5) {
              edges { node { id location { id name } } }
            }
          }
        }`,
        { id: inventoryItemId },
      );

      if (!itemData.inventoryItem) {
        sendJsonError(res, 404, `Inventory item not found: ${inventoryItemId}`);
        return true;
      }

      const levels = itemData.inventoryItem.inventoryLevels.edges;
      if (levels.length === 0) {
        sendJsonError(
          res,
          422,
          "No inventory levels found for this item — item may not be tracked",
        );
        return true;
      }

      let locationId = requestedLocationId;
      if (locationId) {
        const matchingLevel = levels.find(
          (level) => level.node.location.id === locationId,
        );
        if (!matchingLevel) {
          sendJsonError(
            res,
            400,
            `Location ${locationId} is not valid for inventory item ${inventoryItemId}`,
          );
          return true;
        }
      } else if (levels.length === 1) {
        locationId = levels[0].node.location.id;
      } else {
        sendJsonError(
          res,
          400,
          "locationId is required when an inventory item exists in multiple locations",
        );
        return true;
      }

      const adjustData = await shopifyGql<{
        inventoryAdjustQuantities: {
          inventoryAdjustmentGroup: { reason: string } | null;
          userErrors: Array<{ field: string[]; message: string }>;
        };
      }>(
        config,
        `mutation AdjustInventory($input: InventoryAdjustQuantitiesInput!) {
          inventoryAdjustQuantities(input: $input) {
            inventoryAdjustmentGroup { reason }
            userErrors { field message }
          }
        }`,
        {
          input: {
            reason: "correction",
            name: "available",
            changes: [
              {
                inventoryItemId,
                locationId,
                delta,
              },
            ],
          },
        },
      );

      if (adjustData.inventoryAdjustQuantities.userErrors.length) {
        sendJsonError(
          res,
          422,
          adjustData.inventoryAdjustQuantities.userErrors
            .map((error) => error.message)
            .join("; "),
        );
        return true;
      }

      sendJson(res, 200, { ok: true, locationId });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to adjust inventory";
      logger.error(
        `[shopify/inventory/adjust] ${err instanceof Error ? err.message : String(err)}`,
      );
      sendJsonError(res, 500, message);
    }
    return true;
  }

  // ── GET /api/shopify/customers ───────────────────────────────────
  if (method === "GET" && pathname === "/api/shopify/customers") {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const limit = Math.min(
        50,
        Math.max(1, Number(url.searchParams.get("limit") ?? "20")),
      );
      const search = url.searchParams.get("q")?.trim() || null;

      const data = await shopifyGql<{
        customers: {
          edges: Array<{
            node: {
              id: string;
              firstName: string;
              lastName: string;
              email: string;
              ordersCount: number;
              totalSpentV2: { amount: string; currencyCode: string };
              createdAt: string;
            };
          }>;
        };
        customersCount: { count: number };
      }>(
        config,
        `query ListCustomers($first: Int!, $query: String) {
          customers(first: $first, query: $query) {
            edges {
              node {
                id firstName lastName email ordersCount
                totalSpentV2 { amount currencyCode }
                createdAt
              }
            }
          }
          customersCount { count }
        }`,
        { first: limit, query: search },
      );

      const customers = data.customers.edges.map((edge) => ({
        id: edge.node.id,
        firstName: edge.node.firstName ?? "",
        lastName: edge.node.lastName ?? "",
        email: edge.node.email ?? "",
        ordersCount: edge.node.ordersCount,
        totalSpent: edge.node.totalSpentV2.amount,
        currencyCode: edge.node.totalSpentV2.currencyCode,
        createdAt: edge.node.createdAt,
      }));

      sendJson(res, 200, { customers, total: data.customersCount.count });
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to fetch customers";
      logger.error(
        `[shopify/customers] ${err instanceof Error ? err.message : String(err)}`,
      );
      sendJsonError(res, 500, message);
    }
    return true;
  }

  return false;
}

/* ── Helpers ───────────────────────────────────────────────────────── */

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}
