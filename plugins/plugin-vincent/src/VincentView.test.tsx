// @vitest-environment jsdom
//
// Drives the unified VincentView (the single GUI/XR data wrapper that the
// bundle exports for both the "gui" and "xr" modalities) through the rendered
// DOM — the SpatialSurface + VincentSpatialView tree. Asserts the connected
// dashboard (wallet rows, strategy, P&L), and every dispatched interaction:
// Connect / Disconnect (the OAuth flow through useVincentState), Refresh,
// Copy EVM / Copy Solana, and Open Vincent — functional parity with the
// retired standalone TUI surface and the GUI overlay affordances.

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const vincentClientMock = vi.hoisted(() => ({
  vincentStatus: vi.fn(),
  getWalletAddresses: vi.fn(),
  getWalletBalances: vi.fn(),
  vincentStrategy: vi.fn(),
  vincentTradingProfile: vi.fn(),
  vincentStartLogin: vi.fn(),
  vincentDisconnect: vi.fn(),
  vincentUpdateStrategy: vi.fn(),
}));

const openExternalUrl = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("./client", () => ({ vincentClient: vincentClientMock }));

// Keep the real @elizaos/ui (useAppSelector test-fallback, ApiError) but stub
// the external-URL opener so the OAuth/Open-Vincent flows stay deterministic.
vi.mock("@elizaos/ui", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@elizaos/ui")>();
  return { ...actual, openExternalUrl };
});

import { VincentView } from "./VincentView";

const CONNECTED_STATUS = {
  connected: true,
  connectedAt: 1_700_000_000_000,
  tradingVenues: ["hyperliquid", "polymarket"],
};

const ADDRESSES = {
  evmAddress: "0x1234567890abcdef1234",
  solanaAddress: "So11111111111111111111111111111111111111112",
};

const STRATEGY = {
  connected: true,
  strategy: {
    name: "threshold",
    venues: ["hyperliquid", "polymarket"],
    params: { maxPositionUsd: 100 },
    intervalSeconds: 60,
    dryRun: true,
    running: true,
  },
};

const PROFILE = {
  connected: true,
  profile: {
    totalPnl: "12.50",
    winRate: 0.67,
    totalSwaps: 3,
    volume24h: "1000",
    tokenBreakdown: [{ symbol: "BTC", pnl: "10.00", swaps: 2 }],
  },
};

function agent(agentId: string): HTMLElement {
  const el = document.querySelector(`[data-agent-id="${agentId}"]`);
  if (!el) throw new Error(`no element with data-agent-id="${agentId}"`);
  return el as HTMLElement;
}

const clipboardWrite = vi.fn(async () => {});

function mockConnected() {
  vincentClientMock.vincentStatus.mockResolvedValue(CONNECTED_STATUS);
  vincentClientMock.getWalletAddresses.mockResolvedValue(ADDRESSES);
  vincentClientMock.getWalletBalances.mockResolvedValue({
    evm: null,
    solana: null,
  });
  vincentClientMock.vincentStrategy.mockResolvedValue(STRATEGY);
  vincentClientMock.vincentTradingProfile.mockResolvedValue(PROFILE);
  vincentClientMock.vincentDisconnect.mockResolvedValue({ ok: true });
}

function mockDisconnected() {
  vincentClientMock.vincentStatus.mockResolvedValue({
    connected: false,
    connectedAt: null,
    tradingVenues: ["hyperliquid", "polymarket"],
  });
  vincentClientMock.getWalletAddresses.mockResolvedValue({
    evmAddress: null,
    solanaAddress: null,
  });
  vincentClientMock.getWalletBalances.mockResolvedValue({
    evm: null,
    solana: null,
  });
  vincentClientMock.vincentStrategy.mockResolvedValue({
    connected: false,
    strategy: null,
  });
  vincentClientMock.vincentTradingProfile.mockResolvedValue({
    connected: false,
    profile: null,
  });
  vincentClientMock.vincentStartLogin.mockResolvedValue({
    authUrl: "https://heyvincent.ai/oauth",
    state: "state-1",
    redirectUri: "http://localhost/callback/vincent",
  });
}

beforeEach(() => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboardWrite },
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("VincentView — connected dashboard", () => {
  it("loads status/wallet/strategy/profile on mount and renders the populated spatial dashboard", async () => {
    mockConnected();
    render(React.createElement(VincentView));

    await screen.findByText("threshold");
    expect(vincentClientMock.vincentStatus).toHaveBeenCalled();
    expect(vincentClientMock.vincentStrategy).toHaveBeenCalled();
    // Connected → disconnect + refresh + open-vincent controls present.
    expect(agent("disconnect")).toBeTruthy();
    expect(agent("refresh")).toBeTruthy();
    expect(agent("open-vincent")).toBeTruthy();
    // Wallet rows render with copy controls.
    expect(agent("copy-evm")).toBeTruthy();
    expect(agent("copy-solana")).toBeTruthy();
    // P&L token row.
    expect(screen.getByText("BTC")).toBeTruthy();
  });

  it("Disconnect dispatches the OAuth disconnect through the client", async () => {
    mockConnected();
    render(React.createElement(VincentView));
    await screen.findByText("threshold");

    fireEvent.click(agent("disconnect"));
    await waitFor(() =>
      expect(vincentClientMock.vincentDisconnect).toHaveBeenCalledTimes(1),
    );
  });

  it("Refresh re-fetches the dashboard status", async () => {
    mockConnected();
    render(React.createElement(VincentView));
    await screen.findByText("threshold");
    const callsAfterMount = vincentClientMock.vincentStatus.mock.calls.length;

    fireEvent.click(agent("refresh"));
    await waitFor(() =>
      expect(
        vincentClientMock.vincentStatus.mock.calls.length,
      ).toBeGreaterThan(callsAfterMount),
    );
  });

  it("Copy EVM / Copy Solana write the full address to the clipboard", async () => {
    mockConnected();
    render(React.createElement(VincentView));
    await screen.findByText("threshold");

    fireEvent.click(agent("copy-evm"));
    await waitFor(() =>
      expect(clipboardWrite).toHaveBeenCalledWith(ADDRESSES.evmAddress),
    );

    fireEvent.click(agent("copy-solana"));
    await waitFor(() =>
      expect(clipboardWrite).toHaveBeenCalledWith(ADDRESSES.solanaAddress),
    );
  });

  it("Open Vincent opens the external dashboard URL", async () => {
    mockConnected();
    render(React.createElement(VincentView));
    await screen.findByText("threshold");

    fireEvent.click(agent("open-vincent"));
    await waitFor(() =>
      expect(openExternalUrl).toHaveBeenCalledWith("https://heyvincent.ai"),
    );
  });
});

describe("VincentView — disconnected", () => {
  it("renders the Connect call-to-action and dispatches the OAuth login", async () => {
    mockDisconnected();
    render(React.createElement(VincentView));

    await waitFor(() => expect(agent("connect")).toBeTruthy());
    // Connected-only controls are absent while disconnected.
    expect(document.querySelector('[data-agent-id="disconnect"]')).toBeNull();
    expect(document.querySelector('[data-agent-id="open-vincent"]')).toBeNull();

    fireEvent.click(agent("connect"));
    await waitFor(() =>
      expect(vincentClientMock.vincentStartLogin).toHaveBeenCalled(),
    );
    await waitFor(() =>
      expect(openExternalUrl).toHaveBeenCalledWith(
        "https://heyvincent.ai/oauth",
      ),
    );
  });
});
