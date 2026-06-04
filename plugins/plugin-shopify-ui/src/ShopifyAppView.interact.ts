// View-bundle `interact` capability handler, split out of ShopifyAppView.tsx
// so that file exports only React components and stays Fast-Refresh-compatible
// (Vite would full-reload a component file that also exports a plain function).
// The view bundle re-exports `interact` via ./shopify-view-bundle.ts.
import {
  fetchShopifyTuiJson,
  loadShopifyTuiState,
  postShopifyTuiJson,
} from "./ShopifyAppView.helpers";
import type {
  ShopifyCustomersResponse,
  ShopifyInventoryResponse,
  ShopifyOrdersResponse,
  ShopifyProductsResponse,
} from "./useShopifyDashboard";

export async function interact(
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (capability === "terminal-shopify-state") {
    return { viewType: "tui", ...(await loadShopifyTuiState()) };
  }

  if (capability === "terminal-shopify-products") {
    const query = typeof params?.query === "string" ? params.query.trim() : "";
    const page = typeof params?.page === "number" ? params.page : 1;
    const limit = typeof params?.limit === "number" ? params.limit : 20;
    return {
      viewType: "tui",
      products: await fetchShopifyTuiJson<ShopifyProductsResponse>(
        `/api/shopify/products?${new URLSearchParams({
          page: String(page),
          limit: String(limit),
          q: query,
        })}`,
      ),
    };
  }

  if (capability === "terminal-shopify-orders") {
    const status =
      typeof params?.status === "string" ? params.status.trim() : "any";
    const limit = typeof params?.limit === "number" ? params.limit : 20;
    return {
      viewType: "tui",
      orders: await fetchShopifyTuiJson<ShopifyOrdersResponse>(
        `/api/shopify/orders?${new URLSearchParams({
          status,
          limit: String(limit),
        })}`,
      ),
    };
  }

  if (capability === "terminal-shopify-inventory") {
    return {
      viewType: "tui",
      inventory: await fetchShopifyTuiJson<ShopifyInventoryResponse>(
        "/api/shopify/inventory",
      ),
    };
  }

  if (capability === "terminal-shopify-customers") {
    const query = typeof params?.query === "string" ? params.query.trim() : "";
    const limit = typeof params?.limit === "number" ? params.limit : 20;
    return {
      viewType: "tui",
      customers: await fetchShopifyTuiJson<ShopifyCustomersResponse>(
        `/api/shopify/customers?${new URLSearchParams({
          q: query,
          limit: String(limit),
        })}`,
      ),
    };
  }

  if (capability === "terminal-shopify-create-product") {
    const title = typeof params?.title === "string" ? params.title.trim() : "";
    if (!title) throw new Error("title is required");
    return {
      viewType: "tui",
      product: await postShopifyTuiJson("/api/shopify/products", {
        title,
        vendor: typeof params?.vendor === "string" ? params.vendor : undefined,
        productType:
          typeof params?.productType === "string"
            ? params.productType
            : undefined,
        price:
          typeof params?.price === "string" || typeof params?.price === "number"
            ? params.price
            : undefined,
      }),
    };
  }

  if (capability === "terminal-shopify-adjust-inventory") {
    const itemId =
      typeof params?.itemId === "string" ? params.itemId.trim() : "";
    const delta = typeof params?.delta === "number" ? params.delta : null;
    if (!itemId) throw new Error("itemId is required");
    if (delta === null) throw new Error("delta is required");
    return {
      viewType: "tui",
      inventory: await postShopifyTuiJson(
        `/api/shopify/inventory/${encodeURIComponent(itemId)}/adjust`,
        {
          delta,
          locationId:
            typeof params?.locationId === "string"
              ? params.locationId
              : undefined,
        },
      ),
    };
  }

  throw new Error(`Unsupported capability "${capability}"`);
}
