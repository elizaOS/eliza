/**
 * useShopifyDashboard — data hook for the Shopify overlay app.
 *
 * Polls all Shopify API endpoints and exposes typed state for each panel.
 * Handles 404 (service not yet started) gracefully as "disconnected".
 */

import { useCallback, useEffect, useRef, useState } from "react";

// ── Types ─────────────────────────────────────────────────────────────────

export interface ShopifyStatus {
  connected: boolean;
  shop: {
    name: string;
    domain: string;
    plan: string;
    email: string;
    currencyCode: string;
  } | null;
}

export interface ShopifyProduct {
  id: string;
  title: string;
  status: "ACTIVE" | "DRAFT" | "ARCHIVED";
  productType: string;
  vendor: string;
  totalInventory: number;
  priceRange: { min: string; max: string };
  imageUrl: string | null;
  updatedAt: string;
}

export interface ShopifyOrder {
  id: string;
  /** e.g. "#1001" */
  name: string;
  email: string;
  totalPrice: string;
  currencyCode: string;
  fulfillmentStatus: "FULFILLED" | "UNFULFILLED" | "PARTIALLY_FULFILLED" | null;
  financialStatus: "PAID" | "PENDING" | "REFUNDED" | "PARTIALLY_REFUNDED";
  createdAt: string;
  lineItemCount: number;
}

export interface ShopifyInventoryItem {
  id: string;
  sku: string;
  productTitle: string;
  variantTitle: string;
  locationId: string | null;
  locationName: string;
  available: number;
  incoming: number;
}

export interface ShopifyCustomer {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  ordersCount: number;
  totalSpent: string;
  currencyCode: string;
  createdAt: string;
}

export interface ShopifyProductsResponse {
  products: ShopifyProduct[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ShopifyOrdersResponse {
  orders: ShopifyOrder[];
  total: number;
}

export interface ShopifyInventoryResponse {
  items: ShopifyInventoryItem[];
  locations: string[];
}

export interface ShopifyCustomersResponse {
  customers: ShopifyCustomer[];
  total: number;
}

// ── Aggregated counts for the overview card ───────────────────────────────

export interface ShopifyAggregateCounts {
  productCount: number;
  orderCount: number;
  customerCount: number;
}

// ── Hook return shape ─────────────────────────────────────────────────────

export interface UseShopifyDashboardReturn {
  // Connection
  status: ShopifyStatus | null;
  statusLoading: boolean;
  statusError: string | null;

  // Products
  products: ShopifyProduct[];
  productsTotal: number;
  productsPage: number;
  productsLoading: boolean;
  productsError: string | null;
  productSearch: string;
  setProductSearch: (q: string) => void;
  setProductsPage: (page: number) => void;

  // Orders
  orders: ShopifyOrder[];
  ordersTotal: number;
  ordersLoading: boolean;
  ordersError: string | null;
  orderStatusFilter: string;
  setOrderStatusFilter: (s: string) => void;

  // Inventory
  inventoryItems: ShopifyInventoryItem[];
  inventoryLocations: string[];
  inventoryLoading: boolean;
  inventoryError: string | null;

  // Customers
  customers: ShopifyCustomer[];
  customersTotal: number;
  customersLoading: boolean;
  customersError: string | null;
  customerSearch: string;
  setCustomerSearch: (q: string) => void;

  // Aggregate counts
  counts: ShopifyAggregateCounts;

  // Manual refresh
  refresh: () => void;
}

// ── Helpers ───────────────────────────────────────────────────────────────

const PAGE_SIZE = 20;
const POLL_INTERVAL_MS = 30_000;

async function fetchJson<T>(url: string): Promise<T | null> {
  const res = await fetch(url);
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "Unknown error");
    throw new Error(`${res.status}: ${text}`);
  }
  return res.json() as Promise<T>;
}

// ── Hook ──────────────────────────────────────────────────────────────────

export function useShopifyDashboard(): UseShopifyDashboardReturn {
  // -- Status
  const [status, setStatus] = useState<ShopifyStatus | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  // -- Products
  const [productsData, setProductsData] =
    useState<ShopifyProductsResponse | null>(null);
  const [productsLoading, setProductsLoading] = useState(false);
  const [productsError, setProductsError] = useState<string | null>(null);
  const [productsPage, setProductsPage] = useState(1);
  const [productSearch, setProductSearch] = useState("");

  // -- Orders
  const [ordersData, setOrdersData] = useState<ShopifyOrdersResponse | null>(
    null,
  );
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState<string | null>(null);
  const [orderStatusFilter, setOrderStatusFilter] = useState("any");

  // -- Inventory
  const [inventoryData, setInventoryData] =
    useState<ShopifyInventoryResponse | null>(null);
  const [inventoryLoading, setInventoryLoading] = useState(false);
  const [inventoryError, setInventoryError] = useState<string | null>(null);

  // -- Customers
  const [customersData, setCustomersData] =
    useState<ShopifyCustomersResponse | null>(null);
  const [customersLoading, setCustomersLoading] = useState(false);
  const [customersError, setCustomersError] = useState<string | null>(null);
  const [customerSearch, setCustomerSearch] = useState("");

  // -- Tick counter to drive polling
  const [tick, setTick] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(() => {
    setTick((n) => n + 1);
  }, []);

  // Poll every 30 s when the component is mounted
  useEffect(() => {
    pollRef.current = setInterval(refresh, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current !== null) clearInterval(pollRef.current);
    };
  }, [refresh]);

  // -- Fetch status
  useEffect(() => {
    let cancelled = false;
    setStatusLoading(true);
    setStatusError(null);

    fetchJson<ShopifyStatus>("/api/shopify/status")
      .then((data) => {
        if (cancelled) return;
        setStatus(
          data ?? {
            connected: false,
            shop: null,
          },
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setStatusError(
          err instanceof Error ? err.message : "Failed to load Shopify status.",
        );
        setStatus({ connected: false, shop: null });
      })
      .finally(() => {
        if (!cancelled) setStatusLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [tick]);

  const connected = status?.connected ?? false;

  // -- Fetch products (only when connected)
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    setProductsLoading(true);
    setProductsError(null);

    const params = new URLSearchParams({
      page: String(productsPage),
      limit: String(PAGE_SIZE),
      q: productSearch,
    });

    fetchJson<ShopifyProductsResponse>(`/api/shopify/products?${params}`)
      .then((data) => {
        if (cancelled) return;
        setProductsData(
          data ?? {
            products: [],
            total: 0,
            page: productsPage,
            pageSize: PAGE_SIZE,
          },
        );
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setProductsError(
          err instanceof Error ? err.message : "Failed to load products.",
        );
      })
      .finally(() => {
        if (!cancelled) setProductsLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [connected, productsPage, productSearch, tick]);

  // -- Fetch orders
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    setOrdersLoading(true);
    setOrdersError(null);

    const params = new URLSearchParams({
      status: orderStatusFilter,
      limit: String(PAGE_SIZE),
    });

    fetchJson<ShopifyOrdersResponse>(`/api/shopify/orders?${params}`)
      .then((data) => {
        if (cancelled) return;
        setOrdersData(data ?? { orders: [], total: 0 });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setOrdersError(
          err instanceof Error ? err.message : "Failed to load orders.",
        );
      })
      .finally(() => {
        if (!cancelled) setOrdersLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [connected, orderStatusFilter, tick]);

  // -- Fetch inventory
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    setInventoryLoading(true);
    setInventoryError(null);

    fetchJson<ShopifyInventoryResponse>("/api/shopify/inventory")
      .then((data) => {
        if (cancelled) return;
        setInventoryData(data ?? { items: [], locations: [] });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setInventoryError(
          err instanceof Error ? err.message : "Failed to load inventory.",
        );
      })
      .finally(() => {
        if (!cancelled) setInventoryLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [connected, tick]);

  // -- Fetch customers
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;
    setCustomersLoading(true);
    setCustomersError(null);

    const params = new URLSearchParams({
      q: customerSearch,
      limit: String(PAGE_SIZE),
    });

    fetchJson<ShopifyCustomersResponse>(`/api/shopify/customers?${params}`)
      .then((data) => {
        if (cancelled) return;
        setCustomersData(data ?? { customers: [], total: 0 });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setCustomersError(
          err instanceof Error ? err.message : "Failed to load customers.",
        );
      })
      .finally(() => {
        if (!cancelled) setCustomersLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [connected, customerSearch, tick]);

  const counts: ShopifyAggregateCounts = {
    productCount: productsData?.total ?? 0,
    orderCount: ordersData?.total ?? 0,
    customerCount: customersData?.total ?? 0,
  };

  return {
    status,
    statusLoading,
    statusError,

    products: productsData?.products ?? [],
    productsTotal: productsData?.total ?? 0,
    productsPage,
    productsLoading,
    productsError,
    productSearch,
    setProductSearch,
    setProductsPage,

    orders: ordersData?.orders ?? [],
    ordersTotal: ordersData?.total ?? 0,
    ordersLoading,
    ordersError,
    orderStatusFilter,
    setOrderStatusFilter,

    inventoryItems: inventoryData?.items ?? [],
    inventoryLocations: inventoryData?.locations ?? [],
    inventoryLoading,
    inventoryError,

    customers: customersData?.customers ?? [],
    customersTotal: customersData?.total ?? 0,
    customersLoading,
    customersError,
    customerSearch,
    setCustomerSearch,

    counts,
    refresh,
  };
}
