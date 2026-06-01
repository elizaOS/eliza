// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/ui", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
  Badge: ({ children }: { children: React.ReactNode }) =>
    React.createElement("span", {}, children),
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement("button", props, children),
  Skeleton: (props: React.HTMLAttributes<HTMLDivElement>) =>
    React.createElement("div", props),
  Tabs: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", {}, children),
  TabsContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", {}, children),
  TabsList: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", {}, children),
  TabsTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement("button", {}, children),
}));

import { interact, ShopifyTuiView } from "./ShopifyAppView";

const sampleStatus = {
  connected: true,
  shop: {
    name: "Eliza Store",
    domain: "eliza.myshopify.com",
    plan: "Basic",
    email: "ops@example.com",
    currencyCode: "USD",
  },
};

const sampleProducts = {
  products: [
    {
      id: "product-1",
      title: "Terminal Hoodie",
      status: "ACTIVE",
      productType: "Apparel",
      vendor: "Eliza",
      totalInventory: 3,
      priceRange: { min: "42.00", max: "42.00" },
      imageUrl: null,
      updatedAt: "2026-05-18T12:00:00.000Z",
    },
  ],
  total: 1,
  page: 1,
  pageSize: 10,
};

const sampleOrders = {
  orders: [
    {
      id: "order-1",
      name: "#1001",
      email: "buyer@example.com",
      totalPrice: "42.00",
      currencyCode: "USD",
      fulfillmentStatus: "UNFULFILLED",
      financialStatus: "PAID",
      createdAt: "2026-05-18T12:00:00.000Z",
      lineItemCount: 1,
    },
  ],
  total: 1,
};

const sampleInventory = {
  items: [
    {
      id: "inventory-1",
      sku: "HOODIE-1",
      productTitle: "Terminal Hoodie",
      variantTitle: "Black / M",
      locationId: "location-1",
      locationName: "Main",
      available: 3,
      incoming: 0,
    },
  ],
  locations: ["Main"],
};

const sampleCustomers = {
  customers: [
    {
      id: "customer-1",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      ordersCount: 2,
      totalSpent: "84.00",
      currencyCode: "USD",
      createdAt: "2026-05-18T12:00:00.000Z",
    },
  ],
  total: 1,
};

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/shopify/status") return jsonResponse(sampleStatus);
      if (url.startsWith("/api/shopify/products") && init?.method !== "POST") {
        return jsonResponse(sampleProducts);
      }
      if (url === "/api/shopify/products" && init?.method === "POST") {
        return jsonResponse({ product: sampleProducts.products[0] });
      }
      if (url.startsWith("/api/shopify/orders"))
        return jsonResponse(sampleOrders);
      if (url === "/api/shopify/inventory")
        return jsonResponse(sampleInventory);
      if (url.includes("/api/shopify/inventory/") && init?.method === "POST") {
        return jsonResponse({ adjusted: true });
      }
      if (url.startsWith("/api/shopify/customers")) {
        return jsonResponse(sampleCustomers);
      }
      return jsonResponse({ error: `Unexpected ${url}` }, { status: 404 });
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("ShopifyTuiView", () => {
  it("mounts store commerce state and exposes TUI metadata", async () => {
    mockFetch();

    const { container } = render(React.createElement(ShopifyTuiView));

    await screen.findByText("Eliza Store");
    expect(
      screen.getByText("Terminal Hoodie / Black / M @ Main: 3"),
    ).toBeTruthy();
    expect(fetch).toHaveBeenCalledWith("/api/shopify/status");

    const stateElement = container.querySelector("[data-view-state]");
    expect(
      JSON.parse(stateElement?.getAttribute("data-view-state") ?? "{}"),
    ).toMatchObject({
      viewType: "tui",
      viewId: "shopify",
      connected: true,
      domain: "eliza.myshopify.com",
      productCount: 1,
      orderCount: 1,
      inventoryCount: 1,
      lowInventoryCount: 1,
      customerCount: 1,
    });
  });

  it("supports terminal capabilities for state and store operations", async () => {
    mockFetch();

    await expect(interact("terminal-shopify-state")).resolves.toMatchObject({
      viewType: "tui",
      status: sampleStatus,
      products: sampleProducts,
      orders: sampleOrders,
      inventory: sampleInventory,
      customers: sampleCustomers,
    });

    await expect(
      interact("terminal-shopify-products", { query: "hoodie", limit: 5 }),
    ).resolves.toMatchObject({
      viewType: "tui",
      products: sampleProducts,
    });

    await expect(
      interact("terminal-shopify-orders", { status: "unfulfilled", limit: 5 }),
    ).resolves.toMatchObject({
      viewType: "tui",
      orders: sampleOrders,
    });

    await expect(interact("terminal-shopify-inventory")).resolves.toMatchObject(
      {
        viewType: "tui",
        inventory: sampleInventory,
      },
    );

    await expect(
      interact("terminal-shopify-customers", { query: "ada", limit: 5 }),
    ).resolves.toMatchObject({
      viewType: "tui",
      customers: sampleCustomers,
    });

    await expect(
      interact("terminal-shopify-create-product", {
        title: "Terminal Hoodie",
        vendor: "Eliza",
        productType: "Apparel",
        price: "42.00",
      }),
    ).resolves.toMatchObject({
      viewType: "tui",
      product: { product: sampleProducts.products[0] },
    });

    await expect(
      interact("terminal-shopify-adjust-inventory", {
        itemId: "inventory-1",
        delta: 2,
        locationId: "location-1",
      }),
    ).resolves.toEqual({
      viewType: "tui",
      inventory: { adjusted: true },
    });
  });
});
