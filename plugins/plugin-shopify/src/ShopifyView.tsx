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

import { useAgentElement } from "@elizaos/ui/agent-surface";
import { Button } from "@elizaos/ui/components/ui/button";
import { Input } from "@elizaos/ui/components/ui/input";
import { type CSSProperties, useCallback, useState } from "react";
import {
  type ShopifySnapshot,
  ShopifySpatialView,
  type ShopifyTab,
} from "./components/ShopifySpatialView.tsx";
import { useShopifyDashboard } from "./useShopifyDashboard.ts";

const AGENT_TOOLBAR_STYLE: CSSProperties = {
  display: "flex",
  gap: "0.5rem",
  alignItems: "center",
  flexWrap: "wrap",
  padding: "0.4rem 0.5rem",
};

const AGENT_BUTTON_STYLE: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  padding: "0.4rem 0.85rem",
  borderRadius: "0.4rem",
  border: "1px solid var(--primary, #d2691e)",
  background: "var(--primary, #d2691e)",
  color: "var(--primary-foreground, #fff)",
  fontWeight: 600,
  fontSize: "0.85rem",
  cursor: "pointer",
};

const AGENT_INPUT_STYLE: CSSProperties = {
  flex: "1 1 auto",
  minWidth: 0,
  padding: "0.4rem 0.6rem",
  borderRadius: "0.4rem",
  border: "1px solid var(--border, rgba(128,128,128,0.35))",
  background: "transparent",
  color: "inherit",
  fontSize: "0.85rem",
};

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

  // The spatial primitives below carry only inert `data-agent-*` markers, so the
  // GUI/XR wrapper registers the store's primary controls with the live
  // agent-surface registry here, reusing the same dashboard handlers.
  const refreshControl = useAgentElement<HTMLButtonElement>({
    id: "shopify-refresh",
    role: "button",
    label: "Refresh Shopify",
    group: "shopify",
    description:
      "Reload the Shopify store status, products, orders, inventory, and customers",
    status: loading ? "loading" : undefined,
    onActivate: () => {
      refresh();
    },
  });
  const productSearchControl = useAgentElement<HTMLInputElement>({
    id: "shopify-product-search",
    role: "text-input",
    label: "Search products",
    group: "shopify",
    description: "Filter the Shopify product catalog by title or SKU",
    getValue: () => productSearch,
    onFill: (value) => {
      setProductsPage(1);
      setProductSearch(value);
    },
  });

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
    <>
      <div
        role="toolbar"
        aria-label="Shopify controls"
        style={AGENT_TOOLBAR_STYLE}
      >
        <Button
          unstyled
          ref={refreshControl.ref}
          {...refreshControl.agentProps}
          type="button"
          onClick={() => refresh()}
          disabled={loading}
          style={{
            ...AGENT_BUTTON_STYLE,
            opacity: loading ? 0.6 : 1,
            cursor: loading ? "not-allowed" : "pointer",
          }}
        >
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
        <Input
          ref={productSearchControl.ref}
          {...productSearchControl.agentProps}
          type="search"
          aria-label="Search products"
          placeholder="Search products"
          value={productSearch}
          onChange={(event) => {
            setProductsPage(1);
            setProductSearch(event.target.value);
          }}
          style={AGENT_INPUT_STYLE}
        />
      </div>
      <ShopifySpatialView snapshot={snapshot} onAction={onAction} />
    </>
  );
}
