// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/ui", () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement("button", { type: "button", ...props }, children),
  Skeleton: (props: React.HTMLAttributes<HTMLDivElement>) =>
    React.createElement("div", { ...props, "data-skeleton": true }),
}));

vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

import { InventoryLevelsPanel } from "./InventoryLevelsPanel";
import type { ShopifyInventoryItem } from "./useShopifyDashboard";

const items: ShopifyInventoryItem[] = [
  {
    id: "inv-1",
    sku: "HOODIE-1",
    productTitle: "Terminal Hoodie",
    variantTitle: "Black / M",
    locationId: "loc-1",
    locationName: "Main Warehouse",
    available: 3,
    incoming: 5,
  },
  {
    id: "inv-2",
    sku: "STICKER-1",
    productTitle: "Sticker Pack",
    variantTitle: "",
    locationId: "loc-2",
    locationName: "Outlet",
    available: 40,
    incoming: 0,
  },
];

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

function rowFor(productTitle: string): HTMLElement {
  // The row is the nearest container that holds both the title and the buttons.
  const title = screen.getByText(productTitle);
  // title → text div → meta block → row div
  return title.closest("div.flex.flex-wrap") as HTMLElement;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("InventoryLevelsPanel", () => {
  it("renders inventory rows with product, variant·sku, available and incoming", () => {
    render(
      React.createElement(InventoryLevelsPanel, {
        items,
        locations: ["Main Warehouse", "Outlet"],
        loading: false,
        error: null,
      }),
    );

    expect(screen.getByText("Terminal Hoodie")).toBeTruthy();
    expect(screen.getByText("Sticker Pack")).toBeTruthy();
    expect(screen.getByText("Black / M")).toBeTruthy();
    expect(screen.getByText("HOODIE-1")).toBeTruthy();
    expect(screen.getByText("STICKER-1")).toBeTruthy();
    // available + incoming via toLocaleString.
    expect(screen.getByText("3")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
    expect(screen.getByText("40")).toBeTruthy();
    // both items visible → "2 items".
    expect(screen.getByText("2 items")).toBeTruthy();
  });

  it("filters displayed items by the location <select>", () => {
    render(
      React.createElement(InventoryLevelsPanel, {
        items,
        locations: ["Main Warehouse", "Outlet"],
        loading: false,
        error: null,
      }),
    );

    const select = screen.getByLabelText("Location") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "Main Warehouse" } });

    expect(screen.getByText("Terminal Hoodie")).toBeTruthy();
    expect(screen.queryByText("Sticker Pack")).toBeNull();
    expect(screen.getByText("1 item")).toBeTruthy();
  });

  it("shows the location-specific empty state when a filter matches nothing", () => {
    render(
      React.createElement(InventoryLevelsPanel, {
        items: [items[0]],
        locations: ["Main Warehouse", "Outlet"],
        loading: false,
        error: null,
      }),
    );
    const select = screen.getByLabelText("Location") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "Outlet" } });
    expect(screen.getByText("No items at Outlet.")).toBeTruthy();
  });

  it("adjusts inventory up: POSTs {delta, locationId} and optimistically increments", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      React.createElement(InventoryLevelsPanel, {
        items: [items[0]],
        locations: ["Main Warehouse"],
        loading: false,
        error: null,
      }),
    );

    const row = rowFor("Terminal Hoodie");
    const increase = within(row).getByLabelText("Increase inventory by 1");
    fireEvent.click(increase);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/shopify/inventory/inv-1/adjust");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      delta: 1,
      locationId: "loc-1",
    });

    // Optimistic update: 3 → 4.
    await within(row).findByText("4");
  });

  it("adjusts inventory down: POSTs delta -1 and decrements", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);

    render(
      React.createElement(InventoryLevelsPanel, {
        items: [items[0]],
        locations: ["Main Warehouse"],
        loading: false,
        error: null,
      }),
    );

    const row = rowFor("Terminal Hoodie");
    fireEvent.click(within(row).getByLabelText("Decrease inventory by 1"));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(
      JSON.parse(
        (fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string,
      ),
    ).toEqual({ delta: -1, locationId: "loc-1" });
    // Optimistic update: 3 → 2.
    await within(row).findByText("2");
  });

  it("renders adjustError text when the adjust POST fails", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse("nope, out of range", { status: 422 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      React.createElement(InventoryLevelsPanel, {
        items: [items[0]],
        locations: ["Main Warehouse"],
        loading: false,
        error: null,
      }),
    );

    const row = rowFor("Terminal Hoodie");
    fireEvent.click(within(row).getByLabelText("Increase inventory by 1"));

    await within(row).findByText(/nope, out of range/);
    // Available stays at 3 (no optimistic bump on failure).
    expect(within(row).getByText("3")).toBeTruthy();
  });
});
