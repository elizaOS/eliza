// Shared fetch helpers for the Shopify view, used by both ShopifyTuiView
// (in ShopifyAppView.tsx) and the `interact` capability handler
// (in ShopifyAppView.interact.ts). Kept out of the .tsx so that file exports
// only React components and stays Fast-Refresh-compatible in dev.
import type {
  ShopifyCustomersResponse,
  ShopifyInventoryResponse,
  ShopifyOrdersResponse,
  ShopifyProductsResponse,
  ShopifyStatus,
} from "./useShopifyDashboard";

export async function fetchShopifyTuiJson<T>(url: string): Promise<T | null> {
  const response = await fetch(url);
  if (response.status === 404) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      data && typeof data === "object" && "error" in data
        ? String(data.error)
        : `Shopify request failed with ${response.status}`;
    throw new Error(message);
  }
  return data as T;
}

export async function postShopifyTuiJson(
  url: string,
  body: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      data && typeof data === "object" && "error" in data
        ? String(data.error)
        : `Shopify request failed with ${response.status}`;
    throw new Error(message);
  }
  return data;
}

export async function loadShopifyTuiState(): Promise<{
  status: ShopifyStatus;
  products: ShopifyProductsResponse | null;
  orders: ShopifyOrdersResponse | null;
  inventory: ShopifyInventoryResponse | null;
  customers: ShopifyCustomersResponse | null;
}> {
  const status = (await fetchShopifyTuiJson<ShopifyStatus>(
    "/api/shopify/status",
  )) ?? {
    connected: false,
    shop: null,
  };

  if (!status.connected) {
    return {
      status,
      products: null,
      orders: null,
      inventory: null,
      customers: null,
    };
  }

  const [products, orders, inventory, customers] = await Promise.all([
    fetchShopifyTuiJson<ShopifyProductsResponse>(
      "/api/shopify/products?page=1&limit=10&q=",
    ),
    fetchShopifyTuiJson<ShopifyOrdersResponse>(
      "/api/shopify/orders?status=any&limit=10",
    ),
    fetchShopifyTuiJson<ShopifyInventoryResponse>("/api/shopify/inventory"),
    fetchShopifyTuiJson<ShopifyCustomersResponse>(
      "/api/shopify/customers?q=&limit=10",
    ),
  ]);

  return { status, products, orders, inventory, customers };
}
