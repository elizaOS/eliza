// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/ui", () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement("button", { type: "button", ...props }, children),
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) =>
    React.createElement("input", props),
  Skeleton: (props: React.HTMLAttributes<HTMLDivElement>) =>
    React.createElement("div", { ...props, "data-skeleton": true }),
  // Dialog renders its children only when open, like the real Radix dialog.
  Dialog: ({
    open,
    children,
  }: {
    open: boolean;
    onOpenChange?: (next: boolean) => void;
    children: React.ReactNode;
  }) =>
    open ? React.createElement("div", { role: "dialog" }, children) : null,
  DialogContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", {}, children),
  DialogHeader: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", {}, children),
  DialogFooter: ({ children }: { children: React.ReactNode }) =>
    React.createElement("div", {}, children),
  DialogTitle: ({ children }: { children: React.ReactNode }) =>
    React.createElement("h2", {}, children),
}));

vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

import { ProductsPanel } from "./ProductsPanel";
import type { ShopifyProduct } from "./useShopifyDashboard";

const activeProduct: ShopifyProduct = {
  id: "product-1",
  title: "Terminal Hoodie",
  status: "ACTIVE",
  productType: "Apparel",
  vendor: "Eliza",
  totalInventory: 12,
  priceRange: { min: "42.00", max: "42.00" },
  imageUrl: null,
  updatedAt: "2026-05-18T12:00:00.000Z",
};

const draftRangeProduct: ShopifyProduct = {
  id: "product-2",
  title: "Sticker Pack",
  status: "DRAFT",
  productType: "Accessories",
  vendor: "Eliza",
  totalInventory: 999,
  priceRange: { min: "3.00", max: "9.00" },
  imageUrl: null,
  updatedAt: "2026-05-18T12:00:00.000Z",
};

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json" },
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("ProductsPanel", () => {
  it("renders product rows with title, vendor·type, single + range price, inventory and status", () => {
    render(
      React.createElement(ProductsPanel, {
        products: [activeProduct, draftRangeProduct],
        total: 2,
        page: 1,
        loading: false,
        error: null,
        search: "",
        onSearchChange: vi.fn(),
        onPageChange: vi.fn(),
      }),
    );

    expect(screen.getByText("Terminal Hoodie")).toBeTruthy();
    expect(screen.getByText("Sticker Pack")).toBeTruthy();
    // vendor · productType.
    expect(screen.getAllByText("Eliza").length).toBe(2);
    expect(screen.getByText("Apparel")).toBeTruthy();
    expect(screen.getByText("Accessories")).toBeTruthy();
    // single price.
    expect(screen.getByText("42.00")).toBeTruthy();
    // range price.
    expect(screen.getByText("3.00 – 9.00")).toBeTruthy();
    // totalInventory toLocaleString.
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("999")).toBeTruthy();
    // status badges by aria-label.
    expect(screen.getByLabelText("Active")).toBeTruthy();
    expect(screen.getByLabelText("Draft")).toBeTruthy();
  });

  it("resets to page 1 and forwards the query when searching", () => {
    const onSearchChange = vi.fn();
    const onPageChange = vi.fn();
    render(
      React.createElement(ProductsPanel, {
        products: [activeProduct],
        total: 1,
        page: 3,
        loading: false,
        error: null,
        search: "",
        onSearchChange,
        onPageChange,
      }),
    );
    const input = screen.getByPlaceholderText("Search products…");
    fireEvent.change(input, { target: { value: "Sticker" } });
    expect(onSearchChange).toHaveBeenCalledWith("Sticker");
    expect(onPageChange).toHaveBeenCalledWith(1);
  });

  it("renders the pagination label + buttons and respects disabled bounds", () => {
    const onPageChange = vi.fn();
    // total 45, PAGE_SIZE 20 → 3 pages. On page 1, prev disabled, next enabled.
    render(
      React.createElement(ProductsPanel, {
        products: [activeProduct],
        total: 45,
        page: 1,
        loading: false,
        error: null,
        search: "",
        onSearchChange: vi.fn(),
        onPageChange,
      }),
    );
    expect(screen.getByText("45 products · page 1 of 3")).toBeTruthy();
    const prev = screen.getByLabelText("Previous page") as HTMLButtonElement;
    const next = screen.getByLabelText("Next page") as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);
    fireEvent.click(next);
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it("disables next on the last page and enables prev", () => {
    const onPageChange = vi.fn();
    render(
      React.createElement(ProductsPanel, {
        products: [activeProduct],
        total: 45,
        page: 3,
        loading: false,
        error: null,
        search: "",
        onSearchChange: vi.fn(),
        onPageChange,
      }),
    );
    const prev = screen.getByLabelText("Previous page") as HTMLButtonElement;
    const next = screen.getByLabelText("Next page") as HTMLButtonElement;
    expect(prev.disabled).toBe(false);
    expect(next.disabled).toBe(true);
    fireEvent.click(prev);
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it("does not render pagination when total fits a single page", () => {
    render(
      React.createElement(ProductsPanel, {
        products: [activeProduct],
        total: 5,
        page: 1,
        loading: false,
        error: null,
        search: "",
        onSearchChange: vi.fn(),
        onPageChange: vi.fn(),
      }),
    );
    expect(screen.queryByLabelText("Next page")).toBeNull();
  });

  it("shows search vs generic empty states", () => {
    const { rerender } = render(
      React.createElement(ProductsPanel, {
        products: [],
        total: 0,
        page: 1,
        loading: false,
        error: null,
        search: "xyz",
        onSearchChange: vi.fn(),
        onPageChange: vi.fn(),
      }),
    );
    expect(screen.getByText("No products match your search.")).toBeTruthy();
    rerender(
      React.createElement(ProductsPanel, {
        products: [],
        total: 0,
        page: 1,
        loading: false,
        error: null,
        search: "",
        onSearchChange: vi.fn(),
        onPageChange: vi.fn(),
      }),
    );
    expect(screen.getByText("No products found.")).toBeTruthy();
  });

  it("creates a product: opens dialog, gates submit on title, POSTs body, closes on success", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ id: "new", title: "Cap" }, { status: 201 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      React.createElement(ProductsPanel, {
        products: [activeProduct],
        total: 1,
        page: 1,
        loading: false,
        error: null,
        search: "",
        onSearchChange: vi.fn(),
        onPageChange: vi.fn(),
      }),
    );

    // No dialog yet.
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByText("Create"));
    expect(screen.getByRole("dialog")).toBeTruthy();

    // Submit is disabled until a title is present.
    const submit = screen.getByRole("button", {
      name: "Create product",
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText("e.g. Classic T-Shirt"), {
      target: { value: "Cap" },
    });
    fireEvent.change(screen.getByPlaceholderText("e.g. Acme Co."), {
      target: { value: "Eliza" },
    });
    fireEvent.change(screen.getByPlaceholderText("e.g. Apparel"), {
      target: { value: "Hats" },
    });
    fireEvent.change(screen.getByPlaceholderText("0.00"), {
      target: { value: "19.99" },
    });

    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/shopify/products");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({
      title: "Cap",
      vendor: "Eliza",
      productType: "Hats",
      price: "19.99",
    });

    // Dialog closes after a successful create.
    await vi.waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
  });

  it("renders submitError when the create POST fails", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse("Boom: bad title", { status: 422 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    render(
      React.createElement(ProductsPanel, {
        products: [activeProduct],
        total: 1,
        page: 1,
        loading: false,
        error: null,
        search: "",
        onSearchChange: vi.fn(),
        onPageChange: vi.fn(),
      }),
    );

    fireEvent.click(screen.getByText("Create"));
    fireEvent.change(screen.getByPlaceholderText("e.g. Classic T-Shirt"), {
      target: { value: "Cap" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create product" }));

    // The error text is the response body text; the dialog stays open.
    await screen.findByText(/Boom: bad title/);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("closes the dialog when Cancel is clicked", () => {
    render(
      React.createElement(ProductsPanel, {
        products: [activeProduct],
        total: 1,
        page: 1,
        loading: false,
        error: null,
        search: "",
        onSearchChange: vi.fn(),
        onPageChange: vi.fn(),
      }),
    );
    fireEvent.click(screen.getByText("Create"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByText("Cancel"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
