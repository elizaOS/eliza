// @vitest-environment jsdom

/**
 * Drives the unified ShopifyView (the single GUI/XR data wrapper) through the
 * rendered DOM — the same component the bundle exports for the "gui", "xr", and
 * "tui" modalities — asserting the populated store dashboard, tab navigation,
 * overview count-tile shortcuts, products search / create / pagination, orders
 * status filter, customers search, refresh, and the error path. Deterministic:
 * a stubbed `fetch`, no network. The `interact` capability handler keeps its own
 * coverage at the bottom of this file.
 */

import {
  cleanup,
  configure,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ShopifyView } from "./ShopifyView";
import { interact } from "./shopify-interact";

configure({ asyncUtilTimeout: 5000 });

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
  pageSize: 20,
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
  const fetchMock = vi.fn(
    async (input: RequestInfo | URL, init?: RequestInit) => {
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
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function agent(agentId: string): HTMLElement {
  const el = document.querySelector(`[data-agent-id="${agentId}"]`);
  if (!el) throw new Error(`no element with data-agent-id="${agentId}"`);
  return el as HTMLElement;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("ShopifyView — populated dashboard", () => {
  it("loads the store status and renders the connected header + shop name", async () => {
    mockFetch();
    render(React.createElement(ShopifyView));
    await screen.findByText("Eliza Store");
    expect(fetch).toHaveBeenCalledWith("/api/shopify/status");
    expect(screen.getByText("eliza.myshopify.com")).toBeTruthy();
    expect(screen.getByText("connected")).toBeTruthy();
  });

  it("renders the not-connected hint when the store is disconnected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        if (String(input) === "/api/shopify/status")
          return jsonResponse({ connected: false, shop: null });
        return jsonResponse({ error: "not configured" }, { status: 404 });
      }),
    );
    render(React.createElement(ShopifyView));
    await screen.findByText(/Set SHOPIFY_STORE_DOMAIN/);
    expect(screen.getByText("offline")).toBeTruthy();
  });

  it("surfaces a status fetch failure as the error text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network is down");
      }),
    );
    render(React.createElement(ShopifyView));
    await screen.findByText("network is down");
  });
});

describe("ShopifyView — tab navigation", () => {
  it("switches to the orders tab from the tab control and shows orders data", async () => {
    mockFetch();
    render(React.createElement(ShopifyView));
    await screen.findByText("Eliza Store");

    fireEvent.click(agent("tab-orders"));

    await waitFor(() => expect(screen.getByText("#1001")).toBeTruthy());
    expect(screen.getByText(/1 total/)).toBeTruthy();
  });

  it("navigates to the inventory tab via the overview count-tile shortcut", async () => {
    mockFetch();
    render(React.createElement(ShopifyView));
    await screen.findByText("Eliza Store");

    fireEvent.click(agent("overview-inventory"));

    await waitFor(() => expect(screen.getByText(/rows/)).toBeTruthy());
  });
});

describe("ShopifyView — products affordances", () => {
  it("filters the products page via the search field, resetting to page 1", async () => {
    const fetchMock = mockFetch();
    render(React.createElement(ShopifyView));
    await screen.findByText("Eliza Store");

    fireEvent.click(agent("tab-products"));
    await waitFor(() => expect(agent("products-search")).toBeTruthy());

    fireEvent.change(agent("products-search") as HTMLInputElement, {
      target: { value: "hoodie" },
    });

    await waitFor(() => {
      const searched = fetchMock.mock.calls.some(([u]) =>
        String(u).includes("q=hoodie"),
      );
      expect(searched).toBe(true);
    });
  });

  it("creates a product through the bridge from the inline create field + button", async () => {
    const fetchMock = mockFetch();
    render(React.createElement(ShopifyView));
    await screen.findByText("Eliza Store");

    fireEvent.click(agent("tab-products"));
    await waitFor(() => expect(agent("products-create-title")).toBeTruthy());

    fireEvent.change(agent("products-create-title") as HTMLInputElement, {
      target: { value: "Cap" },
    });
    fireEvent.click(agent("products-create"));

    await waitFor(() => {
      const created = fetchMock.mock.calls.find(
        ([u, init]) =>
          String(u) === "/api/shopify/products" &&
          (init as RequestInit | undefined)?.method === "POST",
      );
      expect(created).toBeTruthy();
      expect(
        JSON.parse((created?.[1] as RequestInit).body as string),
      ).toMatchObject({ title: "Cap" });
    });
  });
});

describe("ShopifyView — orders + customers filters", () => {
  it("applies the unfulfilled orders filter from the filter buttons", async () => {
    const fetchMock = mockFetch();
    render(React.createElement(ShopifyView));
    await screen.findByText("Eliza Store");

    fireEvent.click(agent("tab-orders"));
    await waitFor(() =>
      expect(agent("orders-filter-unfulfilled")).toBeTruthy(),
    );

    fireEvent.click(agent("orders-filter-unfulfilled"));

    await waitFor(() => {
      const filtered = fetchMock.mock.calls.some(([u]) =>
        String(u).includes("status=unfulfilled"),
      );
      expect(filtered).toBe(true);
    });
  });

  it("searches customers via the search field", async () => {
    const fetchMock = mockFetch();
    render(React.createElement(ShopifyView));
    await screen.findByText("Eliza Store");

    fireEvent.click(agent("tab-customers"));
    await waitFor(() => expect(agent("customers-search")).toBeTruthy());

    fireEvent.change(agent("customers-search") as HTMLInputElement, {
      target: { value: "ada" },
    });

    await waitFor(() => {
      const searched = fetchMock.mock.calls.some(([u]) =>
        String(u).includes("q=ada"),
      );
      expect(searched).toBe(true);
    });
  });
});

describe("ShopifyView — refresh", () => {
  it("re-fetches the store status when the refresh control is pressed", async () => {
    const fetchMock = mockFetch();
    render(React.createElement(ShopifyView));
    await screen.findByText("Eliza Store");

    const statusCalls = () =>
      fetchMock.mock.calls.filter(([u]) => String(u) === "/api/shopify/status")
        .length;
    const before = statusCalls();
    fireEvent.click(agent("refresh"));
    await waitFor(() => expect(statusCalls()).toBeGreaterThan(before));
  });
});

// The terminal `interact` capability handler is shipped by this plugin's view
// bundle; its coverage moved here from the retired ShopifyTuiView test.
describe("interact — terminal Shopify capabilities", () => {
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
    ).resolves.toMatchObject({ viewType: "tui", products: sampleProducts });

    await expect(
      interact("terminal-shopify-orders", { status: "unfulfilled", limit: 5 }),
    ).resolves.toMatchObject({ viewType: "tui", orders: sampleOrders });

    await expect(interact("terminal-shopify-inventory")).resolves.toMatchObject(
      { viewType: "tui", inventory: sampleInventory },
    );

    await expect(
      interact("terminal-shopify-customers", { query: "ada", limit: 5 }),
    ).resolves.toMatchObject({ viewType: "tui", customers: sampleCustomers });

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
    ).resolves.toEqual({ viewType: "tui", inventory: { adjusted: true } });
  });

  it("rejects invalid interact() invocations", async () => {
    mockFetch();

    await expect(
      interact("terminal-shopify-create-product", {}),
    ).rejects.toThrow(/title is required/);

    await expect(
      interact("terminal-shopify-adjust-inventory", { delta: 1 }),
    ).rejects.toThrow(/itemId is required/);

    await expect(
      interact("terminal-shopify-adjust-inventory", { itemId: "inv-1" }),
    ).rejects.toThrow(/delta is required/);

    await expect(interact("bogus-capability")).rejects.toThrow(
      /Unsupported capability/,
    );
  });

  it("plumbs params into request URLs and bodies", async () => {
    const fetchMock = mockFetch();

    await interact("terminal-shopify-products", {
      query: "hoodie",
      page: 2,
      limit: 5,
    });
    const productsUrl = String(
      fetchMock.mock.calls.find(([u]) =>
        String(u).startsWith("/api/shopify/products"),
      )?.[0],
    );
    expect(productsUrl).toContain("page=2");
    expect(productsUrl).toContain("limit=5");
    expect(productsUrl).toContain("q=hoodie");

    fetchMock.mockClear();
    await interact("terminal-shopify-create-product", {
      title: "  Cap  ",
      vendor: "Eliza",
      productType: "Hats",
      price: "19.99",
    });
    const createCall = fetchMock.mock.calls.find(
      ([u, init]) =>
        String(u) === "/api/shopify/products" &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(createCall).toBeTruthy();
    expect(
      JSON.parse((createCall?.[1] as RequestInit).body as string),
    ).toMatchObject({
      title: "Cap",
      vendor: "Eliza",
      productType: "Hats",
      price: "19.99",
    });
  });
});
