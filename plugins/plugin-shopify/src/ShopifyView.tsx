/**
 * ShopifyView — the single GUI/XR data wrapper for the Shopify surface.
 *
 * It owns the live store data (status / products / orders / inventory /
 * customers polling via {@link useShopifyDashboard}, tab selection, search and
 * filter state, pagination, and product creation) and renders the one
 * presentational {@link ShopifySpatialView} inside a {@link SpatialSurface}.
 * Omitting the `modality` prop lets `SpatialSurface` auto-detect GUI vs XR, so
 * the SAME component serves both surfaces. The TUI surface renders the same
 * `ShopifySpatialView` through the terminal registry (see
 * `register-terminal-view.tsx`).
 */

import { SpatialSurface } from "@elizaos/ui/spatial";
import { useCallback, useState } from "react";
import {
  type ShopifySnapshot,
  type ShopifyTab,
  ShopifySpatialView,
} from "./components/ShopifySpatialView.tsx";
import { useShopifyDashboard } from "./useShopifyDashboard.ts";

export function ShopifyView() {
  const [activeTab, setActiveTab] = useState<ShopifyTab>("overview");
  const [createTitle, setCreateTitle] = useState("");
  const [createError, setCreateError] = useState<string | null>(null);

  const {
    status,
    statusLoading,
    statusError,

    products,
    productsTotal,
    productsPage,
    productsLoading,
    productsError,
    productSearch,
    setProductSearch,
    setProductsPage,

    orders,
    ordersTotal,
    ordersLoading,
    ordersError,
    orderStatusFilter,
    setOrderStatusFilter,

    inventoryItems,
    inventoryLocations,
    inventoryLoading,
    inventoryError,

    customers,
    customersTotal,
    customersLoading,
    customersError,
    customerSearch,
    setCustomerSearch,

    counts,
    refresh,
  } = useShopifyDashboard();

  const createProduct = useCallback(async () => {
    const title = createTitle.trim();
    if (!title) {
      setCreateError("Enter a product title.");
      return;
    }
    setCreateError(null);
    try {
      const res = await fetch("/api/shopify/products", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "Unknown error");
        throw new Error(text);
      }
      setCreateTitle("");
      refresh();
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : "Failed to create product.",
      );
    }
  }, [createTitle, refresh]);

  const onAction = useCallback(
    (action: string) => {
      if (action.startsWith("tab:")) {
        setActiveTab(action.slice("tab:".length) as ShopifyTab);
        return;
      }
      if (action.startsWith("products:search:")) {
        setProductsPage(1);
        setProductSearch(action.slice("products:search:".length));
        return;
      }
      if (action.startsWith("products:create-title:")) {
        setCreateError(null);
        setCreateTitle(action.slice("products:create-title:".length));
        return;
      }
      if (action.startsWith("orders:filter:")) {
        setOrderStatusFilter(action.slice("orders:filter:".length));
        return;
      }
      if (action.startsWith("customers:search:")) {
        setCustomerSearch(action.slice("customers:search:".length));
        return;
      }
      switch (action) {
        case "products:create":
          void createProduct();
          return;
        case "products:prev-page":
          setProductsPage(Math.max(1, productsPage - 1));
          return;
        case "products:next-page":
          setProductsPage(productsPage + 1);
          return;
        case "refresh":
          refresh();
          return;
      }
    },
    [
      createProduct,
      productsPage,
      refresh,
      setCustomerSearch,
      setOrderStatusFilter,
      setProductSearch,
      setProductsPage,
    ],
  );

  const loading =
    statusLoading ||
    productsLoading ||
    ordersLoading ||
    inventoryLoading ||
    customersLoading;
  const error =
    createError ??
    statusError ??
    productsError ??
    ordersError ??
    inventoryError ??
    customersError;

  const snapshot: ShopifySnapshot = {
    status,
    tab: activeTab,
    counts,
    products,
    productsTotal,
    productsPage,
    productSearch,
    orders,
    ordersTotal,
    orderStatusFilter,
    inventoryItems,
    inventoryLocations,
    customers,
    customersTotal,
    customerSearch,
    loading,
    error,
  };

  return (
    <SpatialSurface>
      <ShopifySpatialView snapshot={snapshot} onAction={onAction} />
    </SpatialSurface>
  );
}
