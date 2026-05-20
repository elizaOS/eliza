import { describe, expect, it } from "bun:test";
import { FEED_POINTS_SYMBOL, formatCurrency } from "@feed/shared";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MarketsToggle } from "../../../../apps/web/src/components/shared/MarketsToggle";

describe("formatCurrency (used in MarketsToggle)", () => {
  it("formats amounts correctly", () => {
    expect(formatCurrency(0, { useThousandsSeparator: true })).toBe(
      `${FEED_POINTS_SYMBOL}0.00`,
    );
    expect(formatCurrency(99.99, { useThousandsSeparator: true })).toBe(
      `${FEED_POINTS_SYMBOL}99.99`,
    );
    expect(formatCurrency(-500.25, { useThousandsSeparator: true })).toBe(
      `-${FEED_POINTS_SYMBOL}500.25`,
    );
  });

  it("handles thousand separators", () => {
    const result = formatCurrency(1234.56, { useThousandsSeparator: true });
    expect(result).toBe(`${FEED_POINTS_SYMBOL}1,234.56`);
  });
});

describe("MarketsToggle rendering", () => {
  const noop = () => {};

  it("renders tab buttons as type=button", () => {
    const html = renderToStaticMarkup(
      createElement(MarketsToggle, {
        activeTab: "dashboard",
        onTabChange: noop,
      }),
    );
    expect(html.match(/type="button"/g)?.length).toBe(3);
  });

  it("renders active tab styling", () => {
    const html = renderToStaticMarkup(
      createElement(MarketsToggle, {
        activeTab: "perps",
        onTabChange: noop,
      }),
    );
    expect(html).toMatch(
      /<button[^>]*class="[^"]*text-foreground[^"]*"[^>]*>Perps/,
    );
    expect(html).toMatch(
      /<button[^>]*class="[^"]*text-muted-foreground[^"]*"[^>]*>Dashboard/,
    );
  });

  it("does not render balance when unauthenticated", () => {
    const html = renderToStaticMarkup(
      createElement(MarketsToggle, {
        activeTab: "dashboard",
        onTabChange: noop,
        authenticated: false,
        balance: 1234.56,
        loading: false,
      }),
    );
    expect(html).not.toContain(FEED_POINTS_SYMBOL);
  });

  it("renders skeleton when loading and authenticated", () => {
    const html = renderToStaticMarkup(
      createElement(MarketsToggle, {
        activeTab: "dashboard",
        onTabChange: noop,
        authenticated: true,
        balance: 1234.56,
        loading: true,
      }),
    );
    expect(html).toContain("animate-pulse");
  });

  it("renders formatted balance when authenticated and available", () => {
    const balance = 1234.56;
    const formatted = formatCurrency(balance, { useThousandsSeparator: true });

    const html = renderToStaticMarkup(
      createElement(MarketsToggle, {
        activeTab: "dashboard",
        onTabChange: noop,
        authenticated: true,
        balance,
        loading: false,
      }),
    );
    expect(html).toContain(formatted);
  });
});
