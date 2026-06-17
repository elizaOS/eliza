// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const hyperliquidClient = vi.hoisted(() => ({
  hyperliquidStatus: vi.fn(),
  hyperliquidMarkets: vi.fn(),
  hyperliquidPositions: vi.fn(),
  hyperliquidOrders: vi.fn(),
}));

vi.mock("@elizaos/app-core", () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement("button", { type: "button", ...props }, children),
  client: hyperliquidClient,
  PagePanel: {
    Notice: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", {}, children),
  },
  Spinner: (props: React.HTMLAttributes<HTMLSpanElement>) =>
    React.createElement("span", props),
}));

vi.mock("./client", () => ({}));

import { HyperliquidTuiView } from "./HyperliquidAppView";
import { interact } from "./HyperliquidAppView.interact";

const sampleStatus = {
  publicReadReady: true,
  signerReady: false,
  executionReady: false,
  executionBlockedReason:
    "Signed Hyperliquid exchange mutations are disabled in this build.",
  accountAddress: "0xabc",
  apiBaseUrl: "https://api.hyperliquid.xyz",
  credentialMode: "none" as const,
  readiness: {
    publicReads: true,
    accountReads: true,
    signer: false,
    execution: false,
  },
  account: {
    address: "0xabc",
    source: "env_account" as const,
    guidance: null,
  },
  vault: {
    configured: false,
    ready: false,
    address: null,
    guidance: "Connect a managed vault to enable signed requests.",
  },
  apiWallet: {
    configured: false,
    guidance: "Optional local API wallet is not configured.",
  },
};

const sampleMarkets = {
  markets: [
    {
      name: "BTC",
      index: 0,
      szDecimals: 5,
      maxLeverage: 50,
      onlyIsolated: false,
      isDelisted: false,
    },
  ],
  source: "hyperliquid-info-meta" as const,
  fetchedAt: "2026-05-18T12:00:00.000Z",
};

const samplePositions = {
  accountAddress: "0xabc",
  positions: [
    {
      coin: "BTC",
      size: "0.1",
      entryPx: "70000",
      positionValue: "7000",
      unrealizedPnl: "10",
      returnOnEquity: null,
      liquidationPx: null,
      marginUsed: null,
      leverageType: "cross" as const,
      leverageValue: 10,
    },
  ],
  readBlockedReason: null,
  fetchedAt: "2026-05-18T12:00:00.000Z",
};

const sampleOrders = {
  accountAddress: "0xabc",
  orders: [
    {
      coin: "BTC",
      side: "B" as const,
      limitPx: "71000",
      size: "0.1",
      oid: 1,
      timestamp: 1,
      reduceOnly: false,
      orderType: "limit",
      tif: "Gtc",
      cloid: null,
    },
  ],
  readBlockedReason: null,
  fetchedAt: "2026-05-18T12:00:00.000Z",
};

function mockState() {
  hyperliquidClient.hyperliquidStatus.mockResolvedValue(sampleStatus);
  hyperliquidClient.hyperliquidMarkets.mockResolvedValue(sampleMarkets);
  hyperliquidClient.hyperliquidPositions.mockResolvedValue(samplePositions);
  hyperliquidClient.hyperliquidOrders.mockResolvedValue(sampleOrders);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("HyperliquidTuiView", () => {
  it("mounts market/account state and exposes TUI view metadata", async () => {
    mockState();

    const { container } = render(React.createElement(HyperliquidTuiView));

    await screen.findByText("BTC");
    expect(
      screen.getByText(/Signed Hyperliquid exchange mutations/),
    ).toBeTruthy();
    expect(hyperliquidClient.hyperliquidStatus).toHaveBeenCalled();
    expect(hyperliquidClient.hyperliquidMarkets).toHaveBeenCalled();

    const stateElement = container.querySelector("[data-view-state]");
    expect(
      JSON.parse(stateElement?.getAttribute("data-view-state") ?? "{}"),
    ).toMatchObject({
      viewType: "tui",
      viewId: "hyperliquid",
      publicReadReady: true,
      signerReady: false,
      executionReady: false,
      accountAddress: "0xabc",
      marketCount: 1,
      positionCount: 1,
      orderCount: 1,
    });

    // Header status/counts line.
    expect(
      screen.getByText(/read-ready \| 1 markets \| 1 positions \| 1 orders/),
    ).toBeTruthy();

    // Market row decorations: leverage + szDecimals.
    expect(screen.getByText("50x")).toBeTruthy();
    expect(screen.getByText(/^sz 5$/)).toBeTruthy();

    // Account address line.
    const accountSection = container.querySelector(
      '[aria-label="Hyperliquid account"]',
    ) as HTMLElement;
    expect(accountSection.textContent).toContain("0xabc");
    expect(accountSection.textContent).toContain("Read-only"); // credential label
    expect(accountSection.textContent).toContain("disabled"); // execution

    // Positions row: coin + size + entry + uPnL.
    const positionRow = screen.getByText(
      (_content, el) =>
        el?.parentElement?.getAttribute("aria-label") ===
          "Hyperliquid account" &&
        (el?.textContent ?? "").includes("size 0.1") &&
        (el?.textContent ?? "").includes("entry 70000") &&
        (el?.textContent ?? "").includes("uPnL 10"),
    );
    expect(positionRow).toBeTruthy();

    // Orders row: coin side size @ limitPx.
    const orderRow = screen.getByText(
      (_content, el) =>
        el?.parentElement?.getAttribute("aria-label") ===
          "Hyperliquid account" &&
        (el?.textContent ?? "").includes("BTC") &&
        (el?.textContent ?? "").includes("B") &&
        (el?.textContent ?? "").includes("0.1") &&
        (el?.textContent ?? "").includes("@ 71000"),
    );
    expect(orderRow).toBeTruthy();
  });

  it("renders the read-blocked state with zeroed counts when publicReadReady is false", async () => {
    hyperliquidClient.hyperliquidStatus.mockResolvedValue({
      ...sampleStatus,
      publicReadReady: false,
    });
    // markets/positions/orders are never fetched when read-blocked, but mock
    // them anyway to prove they are skipped.
    hyperliquidClient.hyperliquidMarkets.mockResolvedValue(sampleMarkets);
    hyperliquidClient.hyperliquidPositions.mockResolvedValue(samplePositions);
    hyperliquidClient.hyperliquidOrders.mockResolvedValue(sampleOrders);

    const { container } = render(React.createElement(HyperliquidTuiView));

    await waitFor(() => {
      const stateElement = container.querySelector("[data-view-state]");
      expect(
        JSON.parse(stateElement?.getAttribute("data-view-state") ?? "{}")
          .loading,
      ).toBe(false);
    });

    expect(
      screen.getByText(/read-blocked \| 0 markets \| 0 positions \| 0 orders/),
    ).toBeTruthy();
    expect(screen.queryByText("BTC")).toBeNull();
    expect(hyperliquidClient.hyperliquidMarkets).not.toHaveBeenCalled();

    const viewState = JSON.parse(
      container
        .querySelector("[data-view-state]")
        ?.getAttribute("data-view-state") ?? "{}",
    );
    expect(viewState).toMatchObject({
      publicReadReady: false,
      marketCount: 0,
      positionCount: 0,
      orderCount: 0,
    });
  });

  it("renders the error branch when the loader rejects", async () => {
    hyperliquidClient.hyperliquidStatus.mockRejectedValue(
      new Error("hyperliquid offline"),
    );

    const { container } = render(React.createElement(HyperliquidTuiView));

    await screen.findByText("hyperliquid offline");
    const viewState = JSON.parse(
      container
        .querySelector("[data-view-state]")
        ?.getAttribute("data-view-state") ?? "{}",
    );
    expect(viewState.error).toBe("hyperliquid offline");
    expect(viewState.marketCount).toBe(0);
  });

  it("re-runs the loader and flips lastAction to 'refresh' when the in-view refresh button is clicked", async () => {
    mockState();
    const { container } = render(React.createElement(HyperliquidTuiView));
    await screen.findByText("BTC");
    expect(hyperliquidClient.hyperliquidStatus).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "refresh" }));

    await waitFor(() => {
      expect(hyperliquidClient.hyperliquidStatus).toHaveBeenCalledTimes(2);
    });
    expect(hyperliquidClient.hyperliquidMarkets).toHaveBeenCalledTimes(2);

    const viewState = JSON.parse(
      container
        .querySelector("[data-view-state]")
        ?.getAttribute("data-view-state") ?? "{}",
    );
    expect(viewState.lastAction).toBe("refresh");
  });

  it("supports terminal capabilities for state, market lookup, and execution checks", async () => {
    mockState();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 501,
        json: vi.fn().mockResolvedValue({
          error: "Signed Hyperliquid exchange mutations are disabled.",
        }),
      }),
    );

    await expect(
      interact("terminal-hyperliquid-state", { limit: 1 }),
    ).resolves.toMatchObject({
      viewType: "tui",
      status: sampleStatus,
      markets: [sampleMarkets.markets[0]],
      positions: samplePositions,
      orders: sampleOrders,
    });

    await expect(
      interact("terminal-hyperliquid-market", { coin: "btc" }),
    ).resolves.toMatchObject({
      viewType: "tui",
      market: { name: "BTC", maxLeverage: 50 },
    });

    await expect(
      interact("terminal-hyperliquid-execution-check", {
        coin: "BTC",
        side: "buy",
        size: "0",
      }),
    ).rejects.toThrow("Signed Hyperliquid exchange mutations are disabled.");
    expect(fetch).toHaveBeenCalledWith(
      "/api/hyperliquid/orders/open",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ coin: "BTC", side: "buy", size: "0" }),
      }),
    );
  });

  it("execution-check defaults params and returns the result on an ok response", async () => {
    mockState();
    const okBody = { executionReady: false, accepted: false };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue(okBody),
      }),
    );

    // No params -> defaults coin:'BTC', side:'buy', size:'0'.
    await expect(
      interact("terminal-hyperliquid-execution-check"),
    ).resolves.toEqual({ viewType: "tui", result: okBody });
    expect(fetch).toHaveBeenCalledWith(
      "/api/hyperliquid/orders/open",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ coin: "BTC", side: "buy", size: "0" }),
      }),
    );
  });

  it("market lookup throws on a missing coin and returns null for an unknown coin", async () => {
    mockState();

    await expect(interact("terminal-hyperliquid-market", {})).rejects.toThrow(
      "coin is required",
    );

    await expect(
      interact("terminal-hyperliquid-market", { coin: "DOGE" }),
    ).resolves.toMatchObject({ viewType: "tui", market: null });
  });

  it("throws on an unsupported capability", async () => {
    await expect(interact("terminal-hyperliquid-unknown")).rejects.toThrow(
      'Unsupported capability "terminal-hyperliquid-unknown"',
    );
  });
});
