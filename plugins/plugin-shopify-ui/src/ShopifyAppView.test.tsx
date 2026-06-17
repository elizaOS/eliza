// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

// A faithful-enough Tabs mock: a context carries the active value + setter so
// TabsContent renders only the active tab and TabsTrigger switches it — exactly
// the contract ShopifyAppView depends on for tab navigation.
const TabsCtx = React.createContext<{
  value: string;
  onValueChange: (v: string) => void;
}>({ value: "", onValueChange: () => {} });

vi.mock("@elizaos/ui", () => ({
  Tabs: ({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    children: React.ReactNode;
  }) =>
    React.createElement(
      TabsCtx.Provider,
      { value: { value, onValueChange } },
      children,
    ),
  TabsList: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", {}, children),
  TabsTrigger: ({
    value,
    children,
  }: {
    value: string;
    children: React.ReactNode;
  } & Record<string, unknown>) => {
    const ctx = React.useContext(TabsCtx);
    return React.createElement(
      "button",
      {
        type: "button",
        role: "tab",
        "data-tab-trigger": value,
        onClick: () => ctx.onValueChange(value),
      },
      children,
    );
  },
  TabsContent: ({
    value,
    children,
  }: {
    value: string;
    children: React.ReactNode;
  }) => {
    const ctx = React.useContext(TabsCtx);
    return ctx.value === value ? React.createElement("div", {}, children) : null;
  },
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement("button", props, children),
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) =>
    React.createElement("input", props),
  Badge: ({ children }: { children: React.ReactNode }) =>
    React.createElement("span", {}, children),
  Skeleton: (props: React.HTMLAttributes<HTMLDivElement>) =>
    React.createElement("div", { ...props, "data-skeleton": true }),
  Dialog: ({
    open,
    children,
  }: {
    open: boolean;
    children: React.ReactNode;
  }) => (open ? React.createElement("div", { role: "dialog" }, children) : null),
  DialogContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", {}, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", {}, children),
  DialogFooter: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", {}, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) =>
    React.createElement("h2", {}, children),
  SegmentedControl: ({
    items,
    onValueChange,
  }: {
    value: string;
    onValueChange: (v: string) => void;
    items: Array<{ value: string; label: React.ReactNode }>;
  }) =>
    React.createElement(
      "div",
      {},
      items.map((item) =>
        React.createElement(
          "button",
          {
            key: item.value,
            type: "button",
            onClick: () => onValueChange(item.value),
          },
          item.label,
        ),
      ),
    ),
  formatShortDate: (iso: string) => `date:${iso}`,
}));

vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

import { ShopifyAppView } from "./ShopifyAppView";

const status = {
  connected: true,
  shop: {
    name: "Eliza Store",
    domain: "eliza.myshopify.com",
    plan: "Shopify Plus",
    email: "ops@example.com",
    currencyCode: "USD",
  },
};

const products = {
  products: [
    {
      id: "product-1",
      title: "Terminal Hoodie",
      status: "ACTIVE",
      productType: "Apparel",
      vendor: "Eliza",
      totalInventory: 9,
      priceRange: { min: "42.00", max: "42.00" },
      imageUrl: null,
      updatedAt: "2026-05-18T12:00:00.000Z",
    },
  ],
  total: 7,
  page: 1,
  pageSize: 20,
};

// 12 orders total (>3 → "+N view all" button); 4 returned rows.
const orders = {
  orders: [
    {
      id: "order-1",
      name: "#1001",
      email: "a@example.com",
      totalPrice: "10.00",
      currencyCode: "USD",
      fulfillmentStatus: "UNFULFILLED",
      financialStatus: "PAID",
      createdAt: "2026-05-18T12:00:00.000Z",
      lineItemCount: 1,
    },
    {
      id: "order-2",
      name: "#1002",
      email: "b@example.com",
      totalPrice: "20.00",
      currencyCode: "USD",
      fulfillmentStatus: "FULFILLED",
      financialStatus: "PAID",
      createdAt: "2026-05-18T12:00:00.000Z",
      lineItemCount: 2,
    },
    {
      id: "order-3",
      name: "#1003",
      email: "c@example.com",
      totalPrice: "30.00",
      currencyCode: "USD",
      fulfillmentStatus: "FULFILLED",
      financialStatus: "PAID",
      createdAt: "2026-05-18T12:00:00.000Z",
      lineItemCount: 1,
    },
    {
      id: "order-4",
      name: "#1004",
      email: "d@example.com",
      totalPrice: "40.00",
      currencyCode: "USD",
      fulfillmentStatus: "FULFILLED",
      financialStatus: "PAID",
      createdAt: "2026-05-18T12:00:00.000Z",
      lineItemCount: 1,
    },
  ],
  total: 12,
};

// Inventory: one item available 0 (urgent), one available 3, plus a healthy
// item (available 40). lowInventoryItems (<=5) = 2, urgent (===0) = 1.
const inventory = {
  items: [
    {
      id: "inv-0",
      sku: "OUT-1",
      productTitle: "Sold Out Tee",
      variantTitle: "Red",
      locationId: "loc-1",
      locationName: "Main",
      available: 0,
      incoming: 0,
    },
    {
      id: "inv-1",
      sku: "LOW-1",
      productTitle: "Low Hoodie",
      variantTitle: "Black",
      locationId: "loc-1",
      locationName: "Main",
      available: 3,
      incoming: 0,
    },
    {
      id: "inv-2",
      sku: "OK-1",
      productTitle: "Stocked Mug",
      variantTitle: "",
      locationId: "loc-1",
      locationName: "Main",
      available: 40,
      incoming: 0,
    },
  ],
  locations: ["Main"],
};

const customers = {
  customers: [
    {
      id: "customer-1",
      firstName: "Grace",
      lastName: "Hopper",
      email: "grace@example.com",
      ordersCount: 5,
      totalSpent: "500.00",
      currencyCode: "USD",
      createdAt: "2026-05-18T12:00:00.000Z",
    },
  ],
  total: 4,
};

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function mockFetch() {
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/api/shopify/status") return jsonResponse(status);
      if (url.startsWith("/api/shopify/products") && init?.method !== "POST")
        return jsonResponse(products);
      if (url.startsWith("/api/shopify/orders")) return jsonResponse(orders);
      if (url === "/api/shopify/inventory") return jsonResponse(inventory);
      if (url.startsWith("/api/shopify/customers"))
        return jsonResponse(customers);
      return jsonResponse({ error: `Unexpected ${url}` }, { status: 404 });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("ShopifyAppView (gui + xr)", () => {
  it("renders the connected header with shop name and domain pill", async () => {
    mockFetch();
    render(React.createElement(ShopifyAppView, { exitToApps: vi.fn() }));

    // Header shop name (and StoreOverviewCard name) appear once data loads.
    await screen.findAllByText("Eliza Store");
    // Domain renders in both the header pill and the StoreOverviewCard.
    expect(
      screen.getAllByText("eliza.myshopify.com").length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("re-fetches status when the Refresh button is clicked", async () => {
    const fetchMock = mockFetch();
    render(React.createElement(ShopifyAppView, { exitToApps: vi.fn() }));
    await screen.findAllByText("Eliza Store");

    const statusCalls = () =>
      fetchMock.mock.calls.filter(
        ([u]) => String(u) === "/api/shopify/status",
      ).length;
    const before = statusCalls();
    fireEvent.click(screen.getByLabelText("Refresh"));
    await vi.waitFor(() => expect(statusCalls()).toBeGreaterThan(before));
  });

  it("calls exitToApps when the Back button is clicked", async () => {
    mockFetch();
    const exitToApps = vi.fn();
    render(React.createElement(ShopifyAppView, { exitToApps }));
    await screen.findAllByText("Eliza Store");
    fireEvent.click(screen.getByLabelText("Back to apps"));
    expect(exitToApps).toHaveBeenCalledTimes(1);
  });

  it("renders the overview tiles with counts and derived low-stock values", async () => {
    mockFetch();
    render(React.createElement(ShopifyAppView, { exitToApps: vi.fn() }));
    await screen.findAllByText("Eliza Store");

    // Wait for the populated overview (counts arrive after products/orders load).
    await screen.findByText("7");

    // StoreOverviewCard fields.
    expect(screen.getByText("Shopify Plus")).toBeTruthy();
    expect(screen.getByText("USD")).toBeTruthy();
    expect(screen.getByText("live")).toBeTruthy();

    // Tiles are buttons titled by their label; each shows a unique count value.
    const productsTile = screen.getByTitle("Products");
    expect(productsTile.textContent).toContain("7");
    const ordersTile = screen.getByTitle("Orders");
    expect(ordersTile.textContent).toContain("12");
    const customersTile = screen.getByTitle("Customers");
    expect(customersTile.textContent).toContain("4");
    // Derived low-stock: filter(available<=5) → 2 (Sold Out Tee + Low Hoodie).
    const lowStockTile = screen.getByTitle("Low stock");
    expect(lowStockTile.textContent).toContain("2");
  });

  it("renders recent-orders + low-inventory overview lists with the +N buttons", async () => {
    mockFetch();
    render(React.createElement(ShopifyAppView, { exitToApps: vi.fn() }));
    await screen.findAllByText("Eliza Store");

    // recent-orders first-3 (slice(0,3)): #1001..#1003 shown, #1004 not.
    await screen.findByText("#1001");
    expect(screen.getByText("#1003")).toBeTruthy();
    expect(screen.queryByText("#1004")).toBeNull();
    // "+N" view-all-orders (ordersTotal 12 > 3 → +9).
    expect(screen.getByText("+9")).toBeTruthy();

    // low-inventory list (lowInventoryItems<=5, first 3): Sold Out Tee + Low Hoodie.
    expect(screen.getByText(/Sold Out Tee/)).toBeTruthy();
    expect(screen.getByText(/Low Hoodie/)).toBeTruthy();
  });

  it("navigates to the products tab when the Products tile is clicked", async () => {
    mockFetch();
    render(React.createElement(ShopifyAppView, { exitToApps: vi.fn() }));
    await screen.findAllByText("Eliza Store");

    await screen.findByText("7");
    // ProductsPanel-specific control absent on the overview tab.
    expect(screen.queryByPlaceholderText("Search products…")).toBeNull();
    fireEvent.click(screen.getByTitle("Products"));
    expect(screen.getByPlaceholderText("Search products…")).toBeTruthy();
    // The product row is now visible.
    expect(screen.getByText("Terminal Hoodie")).toBeTruthy();
  });

  it("navigates to orders via the overview '+N view all orders' button", async () => {
    mockFetch();
    render(React.createElement(ShopifyAppView, { exitToApps: vi.fn() }));
    await screen.findAllByText("Eliza Store");

    await screen.findByText("+9");
    fireEvent.click(screen.getByText("+9"));
    // Orders tab → SegmentedControl filter buttons render.
    expect(screen.getByText("Unfulfilled")).toBeTruthy();
    // Order count label specific to OrdersPanel.
    expect(screen.getByText("12 orders")).toBeTruthy();
  });

  it("navigates to the customers tab and shows populated customer data", async () => {
    mockFetch();
    render(React.createElement(ShopifyAppView, { exitToApps: vi.fn() }));
    await screen.findAllByText("Eliza Store");

    await screen.findByText("7");
    fireEvent.click(screen.getByTitle("Customers"));
    expect(
      screen.getByPlaceholderText("Search customers by name or email…"),
    ).toBeTruthy();
    expect(screen.getByText("Grace Hopper")).toBeTruthy();
    expect(screen.getByText("grace@example.com")).toBeTruthy();
    expect(screen.getByText("4 customers")).toBeTruthy();
  });

  it("navigates to the inventory tab and shows the low/urgent items", async () => {
    mockFetch();
    render(React.createElement(ShopifyAppView, { exitToApps: vi.fn() }));
    await screen.findAllByText("Eliza Store");

    await screen.findByText("7");
    // The "Low stock" tile navigates to the inventory tab.
    fireEvent.click(screen.getByTitle("Low stock"));
    expect(screen.getByText("Sold Out Tee")).toBeTruthy();
    expect(screen.getByText("Stocked Mug")).toBeTruthy();
    expect(screen.getByText("3 items")).toBeTruthy();
  });

  it("switches tabs via the tab triggers themselves", async () => {
    mockFetch();
    const { container } = render(
      React.createElement(ShopifyAppView, { exitToApps: vi.fn() }),
    );
    await screen.findByText("7");

    const trigger = (value: string) =>
      container.querySelector(
        `[data-tab-trigger="${value}"]`,
      ) as HTMLButtonElement;

    // All five triggers exist.
    for (const v of [
      "overview",
      "products",
      "orders",
      "inventory",
      "customers",
    ]) {
      expect(trigger(v)).toBeTruthy();
    }

    fireEvent.click(trigger("products"));
    expect(screen.getByPlaceholderText("Search products…")).toBeTruthy();

    fireEvent.click(trigger("customers"));
    expect(
      screen.getByPlaceholderText("Search customers by name or email…"),
    ).toBeTruthy();
    // Switching away from products hides its control.
    expect(screen.queryByPlaceholderText("Search products…")).toBeNull();
  });

  it("shows the setup card when not connected", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === "/api/shopify/status")
        return jsonResponse({ connected: false, shop: null });
      return jsonResponse({ error: "not configured" }, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(React.createElement(ShopifyAppView, { exitToApps: vi.fn() }));

    await screen.findByText("Connect your store");
    // env hints for the two required vars.
    expect(screen.getByText("SHOPIFY_STORE_DOMAIN")).toBeTruthy();
    expect(screen.getByText("SHOPIFY_ACCESS_TOKEN")).toBeTruthy();
    // Configure-in-Settings link.
    expect(screen.getByText("Configure in Settings")).toBeTruthy();
  });
});
