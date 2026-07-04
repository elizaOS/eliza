/**
 * Shared fetch helpers for the Shopify terminal `interact` capability handler
 * (shopify-interact.ts). Pure fetch logic, no React, so it is safe to load in
 * the Node agent process where the terminal capabilities run.
 */
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
  if (!response.ok) {
    // error-policy:J3 error bodies may be non-JSON; parse best-effort only to
    // lift an error message, then fail.
    const errorData = await response.json().catch(() => null);
    const message =
      errorData && typeof errorData === "object" && "error" in errorData
        ? String((errorData as { error?: unknown }).error)
        : `Shopify request failed with ${response.status}`;
    throw new Error(message);
  }
  return (await response.json()) as T;
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
