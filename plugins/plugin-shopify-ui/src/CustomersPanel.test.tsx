// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/ui", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) =>
    React.createElement("input", props),
  Skeleton: (props: React.HTMLAttributes<HTMLDivElement>) =>
    React.createElement("div", { ...props, "data-skeleton": true }),
  // formatShortDate is rendered verbatim so we can assert on a stable value.
  formatShortDate: (iso: string) => `date:${iso}`,
}));

vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

import { CustomersPanel } from "./CustomersPanel";
import type { ShopifyCustomer } from "./useShopifyDashboard";

const customers: ShopifyCustomer[] = [
  {
    id: "customer-1",
    firstName: "Grace",
    lastName: "Hopper",
    email: "grace@example.com",
    ordersCount: 7,
    totalSpent: "1234.50",
    currencyCode: "USD",
    createdAt: "2026-01-02T00:00:00.000Z",
  },
  {
    // Missing names → fullName collapses to the em-dash placeholder.
    id: "customer-2",
    firstName: "",
    lastName: "",
    email: "anon@example.com",
    ordersCount: 0,
    totalSpent: "0.00",
    currencyCode: "USD",
    createdAt: "2026-02-03T00:00:00.000Z",
  },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("CustomersPanel", () => {
  it("renders populated customer rows with name, email, orders, spend and joined date", () => {
    render(
      React.createElement(CustomersPanel, {
        customers,
        total: 2,
        loading: false,
        error: null,
        search: "",
        onSearchChange: vi.fn(),
      }),
    );

    expect(screen.getByText("Grace Hopper")).toBeTruthy();
    expect(screen.getByText("grace@example.com")).toBeTruthy();
    expect(screen.getByText("7")).toBeTruthy();
    // totalSpent + currencyCode share a node ("1234.50 USD" split across text).
    expect(screen.getByText(/1234\.50/)).toBeTruthy();
    expect(screen.getByText("date:2026-01-02T00:00:00.000Z")).toBeTruthy();
    // Missing-name row shows the placeholder.
    expect(screen.getByText("—")).toBeTruthy();
    expect(screen.getByText("anon@example.com")).toBeTruthy();
    // Count label.
    expect(screen.getByText("2 customers")).toBeTruthy();
  });

  it("singularises the count label for a single customer", () => {
    render(
      React.createElement(CustomersPanel, {
        customers: [customers[0]],
        total: 1,
        loading: false,
        error: null,
        search: "",
        onSearchChange: vi.fn(),
      }),
    );
    expect(screen.getByText("1 customer")).toBeTruthy();
  });

  it("shows the search-specific empty state when a query yields nothing", () => {
    render(
      React.createElement(CustomersPanel, {
        customers: [],
        total: 0,
        loading: false,
        error: null,
        search: "zzz",
        onSearchChange: vi.fn(),
      }),
    );
    expect(screen.getByText("No customers match your search.")).toBeTruthy();
  });

  it("shows the generic empty state with no query", () => {
    render(
      React.createElement(CustomersPanel, {
        customers: [],
        total: 0,
        loading: false,
        error: null,
        search: "",
        onSearchChange: vi.fn(),
      }),
    );
    expect(screen.getByText("No customers found.")).toBeTruthy();
  });

  it("renders loading skeletons while empty + loading", () => {
    const { container } = render(
      React.createElement(CustomersPanel, {
        customers: [],
        total: 0,
        loading: true,
        error: null,
        search: "",
        onSearchChange: vi.fn(),
      }),
    );
    expect(
      container.querySelectorAll("[data-skeleton]").length,
    ).toBeGreaterThan(0);
  });

  it("invokes onSearchChange when the search input changes", () => {
    const onSearchChange = vi.fn();
    render(
      React.createElement(CustomersPanel, {
        customers,
        total: 2,
        loading: false,
        error: null,
        search: "",
        onSearchChange,
      }),
    );
    const input = screen.getByPlaceholderText(
      "Search customers by name or email…",
    );
    fireEvent.change(input, { target: { value: "Grace" } });
    expect(onSearchChange).toHaveBeenCalledWith("Grace");
  });
});
