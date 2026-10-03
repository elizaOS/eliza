// @vitest-environment jsdom
/**
 * Drives the crypto terminal through its rendered DOM with every API call
 * served by the real terminal market route handler over recorded CoinGecko
 * payloads. Only the shared `@elizaos/ui` primitives are replaced with plain
 * DOM stand-ins, and the separately tested wallet dashboard with a marker.
 * Covers loading, live list, search, watchlist, chart, paper market and limit
 * orders, reservations, persistence, and the unavailable-data state.
 */
import { readFileSync } from "node:fs";
import type http from "node:http";
import { resolve } from "node:path";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetWalletTerminalMarketRouteForTests,
  __setWalletTerminalFetchForTests,
  handleWalletTerminalMarketRoute,
} from "../routes/wallet-terminal-market-route";

const routeClient = vi.hoisted(() => ({
  fetch: async (path: string): Promise<unknown> => {
    throw new Error(`route client not installed for ${path}`);
  },
}));

vi.mock("@elizaos/ui", () => {
  type Item = { value: string; label: React.ReactNode };
  const h = React.createElement;
  return {
    client: routeClient,
    shellLocalStorage: {
      setItem: (key: string, value: string) =>
        globalThis.window.localStorage.setItem(key, value),
      removeItem: (key: string) =>
        globalThis.window.localStorage.removeItem(key),
      clear: () => globalThis.window.localStorage.clear(),
    },
    cn: (...values: unknown[]) => values.filter(Boolean).join(" "),
    Button: ({
      variant: _variant,
      size: _size,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
      variant?: string;
      size?: string;
    }) => h("button", { type: "button", ...props }),
    Input: (props: React.InputHTMLAttributes<HTMLInputElement>) =>
      h("input", props),
    SegmentedControl: ({
      value,
      onValueChange,
      items,
      "aria-label": label,
    }: {
      value: string;
      onValueChange: (value: string) => void;
      items: Item[];
      "aria-label"?: string;
    }) =>
      h(
        "div",
        { role: "group", "aria-label": label },
        items.map((item) =>
          h(
            "button",
            {
              key: item.value,
              type: "button",
              "aria-pressed": item.value === value,
              onClick: () => onValueChange(item.value),
            },
            item.label,
          ),
        ),
      ),
    Dialog: ({
      open,
      children,
    }: {
      open: boolean;
      children: React.ReactNode;
    }) => (open ? h("div", { role: "dialog" }, children) : null),
    DialogContent: ({ children }: { children: React.ReactNode }) =>
      h("div", null, children),
    DialogHeader: ({ children }: { children: React.ReactNode }) =>
      h("div", null, children),
    DialogFooter: ({ children }: { children: React.ReactNode }) =>
      h("div", null, children),
    DialogTitle: ({ children }: { children: React.ReactNode }) =>
      h("h2", null, children),
    DialogDescription: ({ children }: { children: React.ReactNode }) =>
      h("p", null, children),
  };
});

vi.mock("./components/InventoryAppView.tsx", () => ({
  InventoryAppView: () =>
    React.createElement("div", { "data-testid": "wallet-rich-dashboard" }),
}));

import { CryptoTerminalView } from "./CryptoTerminalView";
import { PAPER_LEDGER_STORAGE_KEY } from "./terminal/terminal-data";

const recorded = JSON.parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      "../routes/__fixtures__/coingecko-markets.recorded.json",
    ),
    "utf8",
  ),
) as { coinGeckoMarkets: Array<Record<string, unknown>> };

let upstreamDown = false;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Serve the view's client calls through the real route handler.
async function viaRoute(path: string): Promise<unknown> {
  const res = {
    statusCode: 0,
    body: "",
    headersSent: false,
    setHeader() {},
    end(body?: string) {
      if (typeof body === "string") this.body = body;
    },
  };
  await handleWalletTerminalMarketRoute(
    {
      method: "GET",
      url: path,
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
    } as unknown as http.IncomingMessage,
    res as unknown as http.ServerResponse,
  );
  const body = JSON.parse(res.body) as { error?: string };
  if (res.statusCode !== 200) {
    throw new Error(body.error ?? `HTTP ${res.statusCode}`);
  }
  return body;
}

beforeEach(() => {
  upstreamDown = false;
  routeClient.fetch = viaRoute;
  __setWalletTerminalFetchForTests(async (input) => {
    if (upstreamDown) return jsonResponse({}, 503);
    const href = String(input);
    if (href.includes("/market_chart")) {
      return jsonResponse({
        prices: [
          [1_700_000_000_000, 64_000],
          [1_700_000_060_000, 65_000],
          [1_700_000_120_000, 65_757],
        ],
      });
    }
    return jsonResponse(recorded.coinGeckoMarkets);
  });
  const values = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, String(value)),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
    },
  });
});

afterEach(() => {
  cleanup();
  __resetWalletTerminalMarketRouteForTests();
});

async function openBitcoin() {
  fireEvent.click(await screen.findByTestId("terminal-market-row-bitcoin"));
  await screen.findByTestId("terminal-price-chart");
}

describe("CryptoTerminalView", () => {
  it("shows a loading state, then live markets with their source", async () => {
    render(<CryptoTerminalView />);
    expect(screen.getByRole("status").textContent).toMatch(
      /Loading live markets/,
    );
    const bitcoinRow = await screen.findByTestId("terminal-market-row-bitcoin");
    expect(bitcoinRow.textContent).toContain("$65,757.00");
    expect(screen.getByTestId("terminal-market-status").textContent).toMatch(
      /Live prices from CoinGecko/,
    );
    expect(screen.getByTestId("terminal-market-row-tether")).toBeTruthy();
  });

  it("filters by search and keeps a starred watchlist", async () => {
    render(<CryptoTerminalView />);
    await screen.findByTestId("terminal-market-row-bitcoin");
    fireEvent.change(screen.getByTestId("terminal-market-search"), {
      target: { value: "eth" },
    });
    expect(screen.queryByTestId("terminal-market-row-bitcoin")).toBeNull();
    expect(screen.getByTestId("terminal-market-row-ethereum")).toBeTruthy();

    fireEvent.click(
      screen.getByRole("button", { name: "Remove Ethereum from watchlist" }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Watchlist" }));
    expect(screen.getByTestId("terminal-market-row-bitcoin")).toBeTruthy();
    expect(screen.queryByTestId("terminal-market-row-ethereum")).toBeNull();
    expect(screen.queryByTestId("terminal-market-row-tether")).toBeNull();
  });

  it("charts live history and fills a paper market buy at the live price", async () => {
    render(<CryptoTerminalView />);
    await openBitcoin();
    expect(
      screen.getByTestId("terminal-price-chart").getAttribute("aria-valuetext"),
    ).toBe("$65,757.00");

    const review = screen.getByTestId(
      "paper-order-review",
    ) as HTMLButtonElement;
    expect(review.disabled).toBe(true);
    fireEvent.change(screen.getByTestId("paper-order-amount"), {
      target: { value: "20000" },
    });
    expect(screen.getByRole("alert").textContent).toContain(
      "Amount exceeds available paper cash.",
    );
    fireEvent.change(screen.getByTestId("paper-order-amount"), {
      target: { value: "6575.70" },
    });
    fireEvent.click(review);
    const dialog = screen.getByRole("dialog");
    expect(dialog.textContent).toMatch(/No wallet is used/);
    expect(dialog.textContent).toContain("0.1 BTC");
    fireEvent.click(within(dialog).getByTestId("paper-order-place"));

    expect(screen.getByRole("status").textContent).toContain(
      "Paper buy filled: 0.1 BTC at $65,757.00.",
    );
    const saved = JSON.parse(
      window.localStorage.getItem(PAPER_LEDGER_STORAGE_KEY) ?? "null",
    );
    expect(saved.cashUsd).toBeCloseTo(3_424.3);
    expect(saved.holdings.bitcoin.units).toBeCloseTo(0.1);

    fireEvent.click(screen.getByRole("button", { name: "Paper portfolio" }));
    expect(screen.getByTestId("paper-total").textContent).toContain(
      "$10,000.00",
    );
    expect(screen.getByTestId("paper-activity").textContent).toMatch(/filled/i);
  });

  it("queues a limit buy, reserves its cash, and releases it on cancel", async () => {
    render(<CryptoTerminalView />);
    await openBitcoin();
    fireEvent.click(screen.getByRole("button", { name: "Limit" }));
    fireEvent.change(screen.getByTestId("paper-order-amount"), {
      target: { value: "4000" },
    });
    fireEvent.change(screen.getByTestId("paper-order-limit"), {
      target: { value: "50000" },
    });
    fireEvent.click(screen.getByTestId("paper-order-review"));
    fireEvent.click(screen.getByTestId("paper-order-place"));
    expect(screen.getByRole("status").textContent).toMatch(
      /queued at \$50,000/,
    );

    fireEvent.click(screen.getByRole("button", { name: "Paper portfolio" }));
    expect(screen.getByText(/\$6,000\.00 available/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByText(/\$10,000\.00 available/)).toBeTruthy();
    expect(screen.getByTestId("paper-activity").textContent).toMatch(
      /cancelled/i,
    );
  });

  it("restores a saved paper portfolio and flags a corrupt one", async () => {
    window.localStorage.setItem(PAPER_LEDGER_STORAGE_KEY, "{broken");
    render(<CryptoTerminalView />);
    await screen.findByTestId("terminal-market-row-bitcoin");
    fireEvent.click(screen.getByRole("button", { name: "Paper portfolio" }));
    expect(screen.getByRole("alert").textContent).toMatch(/not valid JSON/);
    expect(screen.getByTestId("paper-total").textContent).toContain(
      "$10,000.00",
    );
  });

  it("pauses paper trading when live data is unavailable", async () => {
    upstreamDown = true;
    render(<CryptoTerminalView />);
    expect((await screen.findByRole("alert")).textContent).toMatch(
      /Live market data is unavailable \(Failed to load terminal markets\)/,
    );
    expect(screen.queryByTestId("paper-order-review")).toBeNull();
  });

  it("keeps the real wallet dashboard on its own tab", async () => {
    render(<CryptoTerminalView />);
    fireEvent.click(screen.getByRole("button", { name: "Wallet" }));
    expect(screen.getByTestId("wallet-rich-dashboard")).toBeTruthy();
  });
});
