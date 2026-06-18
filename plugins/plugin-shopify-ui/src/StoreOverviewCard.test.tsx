// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it } from "vitest";

import { StoreOverviewCard } from "./StoreOverviewCard";

afterEach(() => {
  cleanup();
});

describe("StoreOverviewCard", () => {
  it("renders the full shop summary with name, domain, currency, plan and live badge", () => {
    render(
      React.createElement(StoreOverviewCard, {
        shop: {
          name: "Eliza Store",
          domain: "eliza.myshopify.com",
          plan: "Shopify Plus",
          email: "ops@example.com",
          currencyCode: "USD",
        },
      }),
    );

    expect(screen.getByText("Eliza Store")).toBeTruthy();
    expect(screen.getByText("eliza.myshopify.com")).toBeTruthy();
    expect(screen.getByText("USD")).toBeTruthy();
    expect(screen.getByText("Shopify Plus")).toBeTruthy();
    // The "live" badge is rendered whenever the connected store card mounts.
    expect(screen.getByText("live")).toBeTruthy();
  });
});
