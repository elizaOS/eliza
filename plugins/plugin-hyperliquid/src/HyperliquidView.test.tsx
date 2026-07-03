// @vitest-environment jsdom

// Drives the unified HyperliquidView (the single GUI/XR data wrapper) through
// the rendered DOM: the same component the bundle exports for the "gui", "xr",
// and (via the spatial terminal registry) "tui" modalities. Asserts the
// populated markets/positions/orders snapshot, the readiness tiles, the
// executionBlockedReason + vault-guidance banners, the positions/orders
// read-blocked surfaces, the DOM-clickable Refresh / Back controls, the
// read-blocked + error + unavailable branches — functional parity with the
// retired HyperliquidTuiView surface. Also covers the unchanged `interact`
// terminal capability handler the view bundle re-exports.

import { NAVIGATE_VIEW_EVENT } from "@elizaos/shared/events";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hyperliquidClient = vi.hoisted(() => ({
  hyperliquidStatus: vi.fn(),
  hyperliquidMarkets: vi.fn(),
  hyperliquidPositions: vi.fn(),
  hyperliquidOrders: vi.fn(),
}));

const { ApiError } = vi.hoisted(() => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message = "api error") {
      super(message);
      this.name = "ApiError";
      this.status = status;
    }
  }
  return { ApiError };
});

vi.mock("@elizaos/app-core", () => ({ client: hyperliquidClient }));
vi.mock("@elizaos/ui", () => ({ ApiError }));
vi.mock("./client", () => ({}));

import { HyperliquidView } from "./HyperliquidView";
import { interact } from "./hyperliquid-interact";

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
    execution: false as const,
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
    {
      name: "ETH",
      index: 1,
      szDecimals: 4,
      maxLeverage: null,
      onlyIsolated: true,
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
      markPx: "70000",
      distanceToLiquidationPct: null,
    },
  ],
  summary: {
    accountValue: "996.19",
    totalNotionalPosition: "7000",
    totalMarginUsed: "700",
    totalRawUsd: "996.19",
    withdrawable: "296.19",
    totalUnrealizedPnl: "10.00",
    effectiveLeverage: 7000 / 996.19,
  },
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

function agent(agentId: string): HTMLElement {
  const el = document.querySelector(`[data-agent-id="${agentId}"]`);
  if (!el) throw new Error(`no element with data-agent-id="${agentId}"`);
  return el as HTMLElement;
}

function mockState() {
  hyperliquidClient.hyperliquidStatus.mockResolvedValue(sampleStatus);
  hyperliquidClient.hyperliquidMarkets.mockResolvedValue(sampleMarkets);
  hyperliquidClient.hyperliquidPositions.mockResolvedValue(samplePositions);
  hyperliquidClient.hyperliquidOrders.mockResolvedValue(sampleOrders);
}

beforeEach(() => {
  mockState();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("HyperliquidView — populated snapshot", () => {
  it("loads status + markets + positions + orders on mount and renders the markets", async () => {
    render(React.createElement(HyperliquidView));
    await screen.findByText("ETH");

    expect(hyperliquidClient.hyperliquidStatus).toHaveBeenCalledTimes(1);
    expect(hyperliquidClient.hyperliquidMarkets).toHaveBeenCalledTimes(1);
    expect(hyperliquidClient.hyperliquidPositions).toHaveBeenCalledTimes(1);
    expect(hyperliquidClient.hyperliquidOrders).toHaveBeenCalledTimes(1);

    expect(screen.getByText("ETH")).toBeTruthy();
    // Read-ready header + market leverage decoration.
    expect(screen.getByText("read-ready")).toBeTruthy();
    expect(screen.getByText("50x")).toBeTruthy();
    // ETH maxLeverage null -> "n/a", isolated suffix.
    const text = document.body.textContent ?? "";
    expect(text).toContain("2m / 1p / 1o");
  });

  it("renders the readiness tiles and the credential-mode label", async () => {
    render(React.createElement(HyperliquidView));
    await screen.findByText("ETH");
    expect(screen.getByText("Reads")).toBeTruthy();
    expect(screen.getByText("Read-only")).toBeTruthy(); // credentialMode "none"
    expect(screen.getByText("Account")).toBeTruthy();
  });

  it("surfaces the executionBlockedReason and vault guidance banners", async () => {
    render(React.createElement(HyperliquidView));
    await screen.findByText("ETH");
    expect(
      screen.getByText(/Signed Hyperliquid exchange mutations are disabled/),
    ).toBeTruthy();
    // vault.ready=false and credentialMode!=local_key -> vault guidance shows.
    expect(
      screen.getByText("Connect a managed vault to enable signed requests."),
    ).toBeTruthy();
  });

  it("renders the agent's own position row with its unrealized PnL", async () => {
    render(React.createElement(HyperliquidView));
    await screen.findByText("ETH");
    // The positions list renders the held BTC row with its size + uPnL.
    const text = document.body.textContent ?? "";
    expect(text).toContain("sz 0.1");
    expect(text).toContain("10");
  });
});

describe("HyperliquidView — read-blocked surfaces", () => {
  it("shows the positions/orders read-blocked reasons instead of empty rows", async () => {
    hyperliquidClient.hyperliquidStatus.mockResolvedValue(sampleStatus);
    hyperliquidClient.hyperliquidMarkets.mockResolvedValue(sampleMarkets);
    hyperliquidClient.hyperliquidPositions.mockResolvedValue({
      accountAddress: null,
      positions: [],
      summary: null,
      readBlockedReason: "Connect an account to read positions.",
      fetchedAt: null,
    });
    hyperliquidClient.hyperliquidOrders.mockResolvedValue({
      accountAddress: null,
      orders: [],
      readBlockedReason: "Connect an account to read orders.",
      fetchedAt: null,
    });

    render(React.createElement(HyperliquidView));
    await screen.findByText("ETH");

    expect(agent("positions-blocked").textContent).toContain(
      "Connect an account to read positions.",
    );
    expect(agent("orders-blocked").textContent).toContain(
      "Connect an account to read orders.",
    );
  });

  it("skips the read calls and shows read-blocked when publicReadReady is false", async () => {
    hyperliquidClient.hyperliquidStatus.mockResolvedValue({
      ...sampleStatus,
      publicReadReady: false,
    });

    render(React.createElement(HyperliquidView));
    await screen.findByText("read-blocked");

    expect(hyperliquidClient.hyperliquidMarkets).not.toHaveBeenCalled();
    expect(hyperliquidClient.hyperliquidPositions).not.toHaveBeenCalled();
    expect(hyperliquidClient.hyperliquidOrders).not.toHaveBeenCalled();
    expect(screen.queryByText("BTC")).toBeNull();
  });
});

describe("HyperliquidView — controls", () => {
  it("the Refresh control re-fetches status + reads", async () => {
    render(React.createElement(HyperliquidView));
    await screen.findByText("ETH");
    expect(hyperliquidClient.hyperliquidStatus).toHaveBeenCalledTimes(1);

    fireEvent.click(agent("refresh"));
    await waitFor(() =>
      expect(hyperliquidClient.hyperliquidStatus).toHaveBeenCalledTimes(2),
    );
    expect(hyperliquidClient.hyperliquidMarkets).toHaveBeenCalledTimes(2);
  });

  it("the Back control navigates home via the eliza:navigate:view bus", async () => {
    render(React.createElement(HyperliquidView));
    await screen.findByText("ETH");

    const events: CustomEvent[] = [];
    const listener = (e: Event) => events.push(e as CustomEvent);
    window.addEventListener(NAVIGATE_VIEW_EVENT, listener);
    try {
      fireEvent.click(agent("back"));
    } finally {
      window.removeEventListener(NAVIGATE_VIEW_EVENT, listener);
    }
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toMatchObject({ viewId: "home", viewPath: "/" });
  });
});

describe("HyperliquidView — error + unavailable paths", () => {
  it("surfaces a read failure as the error text", async () => {
    hyperliquidClient.hyperliquidStatus.mockRejectedValue(
      new Error("hyperliquid offline"),
    );
    render(React.createElement(HyperliquidView));
    await screen.findByText("hyperliquid offline");
  });

  it("degrades to the unavailable state on a 404/503 ApiError (routes not mounted)", async () => {
    hyperliquidClient.hyperliquidStatus.mockRejectedValue(new ApiError(404));
    render(React.createElement(HyperliquidView));
    await screen.findByText("Unavailable");
    // The Back control is still reachable in the unavailable state.
    expect(agent("back")).toBeTruthy();
  });
});

describe("HyperliquidView — terminal interact capabilities", () => {
  it("supports state, market lookup, and execution-check capabilities", async () => {
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
    const okBody = { executionReady: false, accepted: false };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: vi.fn().mockResolvedValue(okBody),
      }),
    );

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
