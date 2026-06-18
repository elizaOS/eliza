// @vitest-environment jsdom
//
// Render test for the standard/XR HyperliquidAppView (the default + viewType:"xr"
// component). Mounts the real component with a mocked patched ElizaClient
// (@elizaos/app-core `client`) so the internal useHyperliquidState hook drives
// the four read endpoints, then asserts populated DATA (market rows, counts,
// status-tile labels, banners) and exercises every interactive control
// (refresh, back) plus the loading + read-blocked + error branches.

import type { OverlayAppContext } from "@elizaos/app-core";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  HyperliquidCredentialMode,
  HyperliquidMarketsResponse,
  HyperliquidOrdersResponse,
  HyperliquidPositionsResponse,
  HyperliquidStatusResponse,
} from "./hyperliquid-contracts";

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
      React.createElement("div", { "data-testid": "notice" }, children),
  },
  Spinner: (props: React.HTMLAttributes<HTMLSpanElement>) =>
    React.createElement("span", { "data-testid": "spinner", ...props }),
}));

vi.mock("./client", () => ({}));

import { HyperliquidAppView } from "./HyperliquidAppView";

function makeStatus(
  overrides: Partial<HyperliquidStatusResponse> = {},
): HyperliquidStatusResponse {
  return {
    publicReadReady: true,
    signerReady: false,
    executionReady: false,
    executionBlockedReason:
      "Signed Hyperliquid exchange mutations are disabled in this build.",
    accountAddress: "0xabc",
    apiBaseUrl: "https://api.hyperliquid.xyz",
    credentialMode: "none",
    readiness: {
      publicReads: true,
      accountReads: true,
      signer: false,
      execution: false,
    },
    account: {
      address: "0xabc",
      source: "env_account",
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
    ...overrides,
  };
}

const markets: HyperliquidMarketsResponse = {
  markets: [
    {
      name: "BTC",
      index: 0,
      szDecimals: 5,
      maxLeverage: 40,
      onlyIsolated: false,
      isDelisted: false,
    },
    {
      name: "ETH",
      index: 1,
      szDecimals: 4,
      maxLeverage: null,
      onlyIsolated: false,
      isDelisted: false,
    },
  ],
  source: "hyperliquid-info-meta",
  fetchedAt: "2026-05-18T12:00:00.000Z",
};

const positions: HyperliquidPositionsResponse = {
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
      leverageType: "cross",
      leverageValue: 10,
    },
  ],
  readBlockedReason: null,
  fetchedAt: "2026-05-18T12:00:00.000Z",
};

const orders: HyperliquidOrdersResponse = {
  accountAddress: "0xabc",
  orders: [
    {
      coin: "BTC",
      side: "B",
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

function mockReads(status: HyperliquidStatusResponse = makeStatus()) {
  hyperliquidClient.hyperliquidStatus.mockResolvedValue(status);
  hyperliquidClient.hyperliquidMarkets.mockResolvedValue(markets);
  hyperliquidClient.hyperliquidPositions.mockResolvedValue(positions);
  hyperliquidClient.hyperliquidOrders.mockResolvedValue(orders);
}

function ctx(overrides: Partial<OverlayAppContext> = {}): OverlayAppContext {
  return {
    exitToApps: vi.fn(),
    uiTheme: "dark",
    t: (key: string) => key,
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("HyperliquidAppView (standard/XR)", () => {
  it("renders populated market rows, counts, and status tiles", async () => {
    mockReads();
    const { container } = render(
      React.createElement(HyperliquidAppView, ctx()),
    );

    // Shell mounts.
    expect(
      container.querySelector('[data-testid="hyperliquid-shell"]'),
    ).toBeTruthy();

    // Market rows render specific data: name + leverage + szDecimals.
    const btc = await screen.findByText("BTC");
    expect(btc).toBeTruthy();
    expect(screen.getByText("ETH")).toBeTruthy();
    expect(screen.getByText("40x")).toBeTruthy(); // BTC maxLeverage 40
    expect(screen.getByText("—")).toBeTruthy(); // ETH maxLeverage null -> em dash
    expect(screen.getByText("sz 5")).toBeTruthy(); // BTC szDecimals
    expect(screen.getByText("sz 4")).toBeTruthy(); // ETH szDecimals

    // Markets count badge equals fixture length.
    const marketsHeading = screen.getByText("Markets");
    const marketsSection = marketsHeading.closest("section");
    expect(marketsSection).toBeTruthy();
    // The count badge ("2") is the sibling span after the heading.
    expect(marketsSection?.querySelector(".ml-auto")?.textContent).toBe(
      String(markets.markets.length),
    );

    // Positions / Orders cards render their numeric counts.
    const positionsHeading = screen.getByText("Positions");
    const positionsCard = positionsHeading.closest("div")?.parentElement;
    expect(positionsCard?.textContent).toContain("1");
    const ordersHeading = screen.getByText("Orders");
    const ordersCard = ordersHeading.closest("div")?.parentElement;
    expect(ordersCard?.textContent).toContain("1");

    // The three StatusTiles render their labels.
    expect(screen.getByText("Reads")).toBeTruthy();
    expect(screen.getByText("Read-only")).toBeTruthy(); // credentialMode "none"
    expect(screen.getByText("Account")).toBeTruthy(); // account.address present
  });

  it("maps credentialMode -> Managed vault label and signer-ready styling", async () => {
    mockReads(
      makeStatus({ credentialMode: "managed_vault", signerReady: true }),
    );
    render(React.createElement(HyperliquidAppView, ctx()));
    await screen.findByText("BTC");
    const tile = screen.getByText("Managed vault");
    expect(tile).toBeTruthy();
    // ready=signerReady=true -> tile icon uses text-ok; the icon is the tile's
    // sibling; assert the parent tile contains the ok-colored icon.
    const tileRoot = tile.closest("div");
    expect(tileRoot?.querySelector(".text-ok")).toBeTruthy();
  });

  it("maps credentialMode -> Local key label", async () => {
    mockReads(makeStatus({ credentialMode: "local_key", signerReady: true }));
    render(React.createElement(HyperliquidAppView, ctx()));
    await screen.findByText("BTC");
    expect(screen.getByText("Local key")).toBeTruthy();
  });

  it("maps missing account -> 'No account' tile", async () => {
    mockReads(
      makeStatus({
        accountAddress: null,
        account: { address: null, source: "none", guidance: null },
      }),
    );
    render(React.createElement(HyperliquidAppView, ctx()));
    await screen.findByText("BTC");
    expect(screen.getByText("No account")).toBeTruthy();
  });

  it("renders the executionBlockedReason banner", async () => {
    mockReads(
      makeStatus({ executionBlockedReason: "Execution is intentionally off." }),
    );
    render(React.createElement(HyperliquidAppView, ctx()));
    await screen.findByText("BTC");
    expect(screen.getByText("Execution is intentionally off.")).toBeTruthy();
  });

  it("renders the vault.guidance banner only when status && !vault.ready && mode!=local_key", async () => {
    mockReads(
      makeStatus({
        credentialMode: "none",
        vault: {
          configured: false,
          ready: false,
          address: null,
          guidance: "Connect a vault to sign requests.",
        },
      }),
    );
    render(React.createElement(HyperliquidAppView, ctx()));
    await screen.findByText("BTC");
    expect(screen.getByText("Connect a vault to sign requests.")).toBeTruthy();
  });

  it("hides the vault.guidance banner when credentialMode is local_key", async () => {
    mockReads(
      makeStatus({
        credentialMode: "local_key",
        signerReady: true,
        vault: {
          configured: false,
          ready: false,
          address: null,
          guidance: "Connect a vault to sign requests.",
        },
      }),
    );
    render(React.createElement(HyperliquidAppView, ctx()));
    await screen.findByText("BTC");
    expect(screen.queryByText("Connect a vault to sign requests.")).toBeNull();
  });

  it("renders readBlockedReason text + Blocked pill instead of counts", async () => {
    const status = makeStatus();
    hyperliquidClient.hyperliquidStatus.mockResolvedValue(status);
    hyperliquidClient.hyperliquidMarkets.mockResolvedValue(markets);
    hyperliquidClient.hyperliquidPositions.mockResolvedValue({
      accountAddress: null,
      positions: [],
      readBlockedReason: "Connect an account to read positions.",
      fetchedAt: null,
    });
    hyperliquidClient.hyperliquidOrders.mockResolvedValue({
      accountAddress: null,
      orders: [],
      readBlockedReason: "Connect an account to read orders.",
      fetchedAt: null,
    });

    render(React.createElement(HyperliquidAppView, ctx()));
    await screen.findByText("BTC");

    expect(
      screen.getByText("Connect an account to read positions."),
    ).toBeTruthy();
    expect(screen.getByText("Connect an account to read orders.")).toBeTruthy();
    // ReadinessPill aria-label flips to "Blocked".
    expect(screen.getAllByLabelText("Blocked").length).toBe(2);
  });

  it("renders the error notice when a read rejects", async () => {
    hyperliquidClient.hyperliquidStatus.mockRejectedValue(
      new Error("network down"),
    );
    render(React.createElement(HyperliquidAppView, ctx()));
    const notice = await screen.findByTestId("notice");
    expect(notice.textContent).toBe("network down");
  });

  it("re-invokes the read methods when the refresh button is clicked", async () => {
    mockReads();
    render(React.createElement(HyperliquidAppView, ctx()));
    await screen.findByText("BTC");

    expect(hyperliquidClient.hyperliquidStatus).toHaveBeenCalledTimes(1);
    expect(hyperliquidClient.hyperliquidMarkets).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText("Refresh"));

    await waitFor(() => {
      expect(hyperliquidClient.hyperliquidStatus).toHaveBeenCalledTimes(2);
    });
    expect(hyperliquidClient.hyperliquidMarkets).toHaveBeenCalledTimes(2);
    expect(hyperliquidClient.hyperliquidPositions).toHaveBeenCalledTimes(2);
    expect(hyperliquidClient.hyperliquidOrders).toHaveBeenCalledTimes(2);
  });

  it("shows the loading spinner and disables refresh while status is pending", async () => {
    // Status promise never resolves -> loading stays true, markets stays null.
    let _resolve: ((s: HyperliquidStatusResponse) => void) | undefined;
    hyperliquidClient.hyperliquidStatus.mockReturnValue(
      new Promise<HyperliquidStatusResponse>((r) => {
        _resolve = r;
      }),
    );
    render(React.createElement(HyperliquidAppView, ctx()));

    expect(await screen.findByTestId("spinner")).toBeTruthy();
    expect(screen.getByText("Loading Hyperliquid state")).toBeTruthy();
    expect(
      (screen.getByLabelText("Refresh") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("calls exitToApps when the back button is clicked", async () => {
    mockReads();
    const exitToApps = vi.fn();
    render(React.createElement(HyperliquidAppView, ctx({ exitToApps })));
    await screen.findByText("BTC");

    fireEvent.click(screen.getByLabelText("Back"));
    expect(exitToApps).toHaveBeenCalledTimes(1);
  });

  it("clears markets/positions/orders when publicReadReady is false (read-blocked)", async () => {
    // publicReadReady=false -> hook skips the Promise.all read calls and the
    // markets section renders 0 (markets stays null).
    hyperliquidClient.hyperliquidStatus.mockResolvedValue(
      makeStatus({ publicReadReady: false }),
    );
    render(React.createElement(HyperliquidAppView, ctx()));

    // Reads tile reflects the not-ready state, and no market row mounts.
    await screen.findByText("Reads");
    await waitFor(() => {
      expect(screen.queryByText("BTC")).toBeNull();
    });
    expect(hyperliquidClient.hyperliquidMarkets).not.toHaveBeenCalled();
    expect(hyperliquidClient.hyperliquidPositions).not.toHaveBeenCalled();
    expect(hyperliquidClient.hyperliquidOrders).not.toHaveBeenCalled();
    // Markets count badge reads 0.
    const marketsSection = screen.getByText("Markets").closest("section");
    expect(marketsSection?.querySelector(".ml-auto")?.textContent).toBe("0");
  });
});

// Type-only assertion so the unused import is meaningful: the mocked status
// objects above must satisfy the real credential-mode union.
const _modes: HyperliquidCredentialMode[] = [
  "managed_vault",
  "local_key",
  "none",
];
void _modes;
