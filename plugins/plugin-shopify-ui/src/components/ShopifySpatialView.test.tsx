import { visibleWidth } from "@elizaos/tui";
import { SpatialSurface } from "@elizaos/ui/spatial";
import {
  getTerminalView,
  registerSpatialTerminalView,
  renderViewToLines,
} from "@elizaos/ui/spatial/tui";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  type ShopifySnapshot,
  ShopifySpatialView,
} from "./ShopifySpatialView.tsx";

const snapshot: ShopifySnapshot = {
  status: {
    connected: true,
    shop: {
      name: "Eliza Store",
      domain: "eliza.myshopify.com",
      plan: "Basic",
      email: "ops@example.com",
      currencyCode: "USD",
    },
  },
  tab: "overview",
  counts: { productCount: 42, orderCount: 7, customerCount: 19 },
  products: [
    {
      id: "p1",
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
  productsTotal: 42,
  productsPage: 1,
  productSearch: "",
  orders: [
    {
      id: "o1",
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
  ordersTotal: 7,
  orderStatusFilter: "any",
  inventoryItems: [
    {
      id: "i1",
      sku: "HOODIE-1",
      productTitle: "Terminal Hoodie",
      variantTitle: "Black / M",
      locationId: "loc1",
      locationName: "Main",
      available: 0,
      incoming: 5,
    },
  ],
  inventoryLocations: ["Main"],
  customers: [
    {
      id: "c1",
      firstName: "Ada",
      lastName: "Lovelace",
      email: "ada@example.com",
      ordersCount: 2,
      totalSpent: "84.00",
      currencyCode: "USD",
      createdAt: "2026-05-18T12:00:00.000Z",
    },
  ],
  customersTotal: 19,
  customerSearch: "",
};

const view = <ShopifySpatialView snapshot={snapshot} />;

describe("ShopifySpatialView one source, three modalities", () => {
  it("TUI: renders to terminal lines honoring the width contract (54 + 32)", () => {
    for (const width of [54, 32]) {
      const lines = renderViewToLines(view, width);
      for (const line of lines) expect(visibleWidth(line)).toBe(width);
      const flat = lines.join("\n");
      expect(flat).toContain("Shopify");
      expect(flat).toContain("connected");
      expect(flat).toContain("eliza.myshopify.com");
      expect(flat).toContain("#1001"); // recent order
      expect(flat).toContain("Terminal Hoodie"); // low inventory row
      expect(flat).toContain("Overview"); // tab control
    }
  });

  it("GUI + XR: renders DOM with agent hooks, XR scaled up", () => {
    const gui = renderToStaticMarkup(
      <SpatialSurface modality="gui">{view}</SpatialSurface>,
    );
    const xr = renderToStaticMarkup(
      <SpatialSurface modality="xr">{view}</SpatialSurface>,
    );
    expect(gui).toContain('data-spatial-surface="gui"');
    expect(xr).toContain('data-spatial-surface="xr"');
    for (const html of [gui, xr]) {
      expect(html).toContain("eliza.myshopify.com");
      expect(html).toContain("#1001");
      expect(html).toContain('data-agent-id="refresh"');
      expect(html).toContain('data-agent-id="tab-orders"');
    }
  });

  it("renders the active products section when the tab is products", () => {
    const lines = renderViewToLines(
      <ShopifySpatialView snapshot={{ ...snapshot, tab: "products" }} />,
      54,
    );
    for (const line of lines) expect(visibleWidth(line)).toBe(54);
    const flat = lines.join("\n");
    expect(flat).toContain("Terminal Hoodie");
    expect(flat).toContain("42 total");
  });

  it("registers as a terminal view the agent terminal can mount and render", () => {
    const unregister = registerSpatialTerminalView("shopify-test", () => view);
    try {
      const component = getTerminalView("shopify-test");
      expect(component).toBeTruthy();
      const lines = component?.render(50) ?? [];
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) expect(visibleWidth(line)).toBe(50);
      expect(lines.join("\n")).toContain("eliza.myshopify.com");
    } finally {
      unregister();
    }
  });
});
