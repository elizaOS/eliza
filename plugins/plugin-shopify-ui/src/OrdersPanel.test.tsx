// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/ui", () => ({
  Skeleton: (props: React.HTMLAttributes<HTMLDivElement>) =>
    React.createElement("div", { ...props, "data-skeleton": true }),
  formatShortDate: (iso: string) => `date:${iso}`,
  // Real SegmentedControl renders one button per item and calls onValueChange.
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
            "data-segment": item.value,
            onClick: () => onValueChange(item.value),
          },
          item.label,
        ),
      ),
    ),
}));

vi.mock("@elizaos/ui/agent-surface", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
}));

import { OrdersPanel } from "./OrdersPanel";
import type { ShopifyOrder } from "./useShopifyDashboard";

const orders: ShopifyOrder[] = [
  {
    id: "gid://shopify/Order/1001",
    name: "#1001",
    email: "buyer@example.com",
    totalPrice: "84.00",
    currencyCode: "USD",
    fulfillmentStatus: "UNFULFILLED",
    financialStatus: "PAID",
    createdAt: "2026-05-18T12:00:00.000Z",
    lineItemCount: 1,
  },
  {
    id: "gid://shopify/Order/1002",
    name: "#1002",
    email: "",
    totalPrice: "12.50",
    currencyCode: "USD",
    fulfillmentStatus: "FULFILLED",
    financialStatus: "REFUNDED",
    createdAt: "2026-05-19T12:00:00.000Z",
    lineItemCount: 3,
  },
  {
    id: "gid://shopify/Order/1003",
    name: "#1003",
    email: "third@example.com",
    totalPrice: "5.00",
    currencyCode: "USD",
    fulfillmentStatus: "PARTIALLY_FULFILLED",
    financialStatus: "PENDING",
    createdAt: "2026-05-20T12:00:00.000Z",
    lineItemCount: 2,
  },
];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("OrdersPanel", () => {
  it("renders order rows with name, line-item count, email-or-dash, total, date and badges", () => {
    render(
      React.createElement(OrdersPanel, {
        orders,
        total: 3,
        loading: false,
        error: null,
        statusFilter: "any",
        onStatusFilterChange: vi.fn(),
      }),
    );

    expect(screen.getByText("#1001")).toBeTruthy();
    expect(screen.getByText("#1002")).toBeTruthy();
    expect(screen.getByText("#1003")).toBeTruthy();
    // Singular/plural line item.
    expect(screen.getByText("1 item")).toBeTruthy();
    expect(screen.getByText("3 items")).toBeTruthy();
    // email present + the empty-email dash.
    expect(screen.getByText("buyer@example.com")).toBeTruthy();
    expect(screen.getByText("—")).toBeTruthy();
    // totals + currency (price and code share one span → match the full text).
    expect(screen.getByText("84.00 USD")).toBeTruthy();
    expect(screen.getByText("12.50 USD")).toBeTruthy();
    // date via formatShortDate.
    expect(screen.getByText("date:2026-05-18T12:00:00.000Z")).toBeTruthy();
    // status badges (collapsed rows render exactly one of each).
    expect(screen.getByLabelText("Unfulfilled")).toBeTruthy();
    expect(screen.getByLabelText("Paid")).toBeTruthy();
    expect(screen.getByLabelText("Fulfilled")).toBeTruthy();
    expect(screen.getByLabelText("Refunded")).toBeTruthy();
    expect(screen.getByLabelText("Partial")).toBeTruthy();
    expect(screen.getByLabelText("Pending")).toBeTruthy();
    // count label.
    expect(screen.getByText("3 orders")).toBeTruthy();
  });

  it("expands an order row to reveal the detail grid, then collapses again", () => {
    render(
      React.createElement(OrdersPanel, {
        orders: [orders[0]],
        total: 1,
        loading: false,
        error: null,
        statusFilter: "any",
        onStatusFilterChange: vi.fn(),
      }),
    );

    // Collapsed: detail-only labels absent.
    expect(screen.queryByText("Order ID")).toBeNull();

    const row = screen
      .getByText("#1001")
      .closest("button") as HTMLButtonElement;
    expect(row.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(row);
    expect(row.getAttribute("aria-expanded")).toBe("true");

    expect(screen.getByText("Order ID")).toBeTruthy();
    // The full order id value appears in the detail grid.
    expect(screen.getByText("gid://shopify/Order/1001")).toBeTruthy();
    expect(screen.getByText("Customer")).toBeTruthy();
    expect(screen.getByText("Created")).toBeTruthy();
    // Total + Created date now appear twice (header + detail).
    expect(screen.getAllByText("date:2026-05-18T12:00:00.000Z").length).toBe(2);

    fireEvent.click(row);
    expect(screen.queryByText("Order ID")).toBeNull();
  });

  it("singularises the order count for a single order", () => {
    render(
      React.createElement(OrdersPanel, {
        orders: [orders[0]],
        total: 1,
        loading: false,
        error: null,
        statusFilter: "any",
        onStatusFilterChange: vi.fn(),
      }),
    );
    expect(screen.getByText("1 order")).toBeTruthy();
  });

  it("fires onStatusFilterChange from the segmented control", () => {
    const onStatusFilterChange = vi.fn();
    render(
      React.createElement(OrdersPanel, {
        orders,
        total: 3,
        loading: false,
        error: null,
        statusFilter: "any",
        onStatusFilterChange,
      }),
    );
    fireEvent.click(screen.getByText("Unfulfilled"));
    expect(onStatusFilterChange).toHaveBeenCalledWith("unfulfilled");
    fireEvent.click(screen.getByText("Fulfilled"));
    expect(onStatusFilterChange).toHaveBeenCalledWith("fulfilled");
    fireEvent.click(screen.getByText("All"));
    expect(onStatusFilterChange).toHaveBeenCalledWith("any");
  });

  it("renders per-filter empty states", () => {
    const { rerender } = render(
      React.createElement(OrdersPanel, {
        orders: [],
        total: 0,
        loading: false,
        error: null,
        statusFilter: "any",
        onStatusFilterChange: vi.fn(),
      }),
    );
    expect(screen.getByText("No orders found.")).toBeTruthy();

    rerender(
      React.createElement(OrdersPanel, {
        orders: [],
        total: 0,
        loading: false,
        error: null,
        statusFilter: "unfulfilled",
        onStatusFilterChange: vi.fn(),
      }),
    );
    expect(screen.getByText("No unfulfilled orders.")).toBeTruthy();

    rerender(
      React.createElement(OrdersPanel, {
        orders: [],
        total: 0,
        loading: false,
        error: null,
        statusFilter: "fulfilled",
        onStatusFilterChange: vi.fn(),
      }),
    );
    expect(screen.getByText("No fulfilled orders.")).toBeTruthy();
  });
});
