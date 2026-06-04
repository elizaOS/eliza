// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

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

vi.mock("@elizaos/ui", () => ({
  useAgentElement: () => ({ ref: { current: null }, agentProps: {} }),
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement("button", props, children),
  PagePanel: {
    Notice: ({ children }: { children: React.ReactNode }) =>
      React.createElement("div", {}, children),
  },
  Spinner: (props: React.HTMLAttributes<HTMLSpanElement>) =>
    React.createElement("span", props),
  useApp: () => ({ setActionNotice: vi.fn() }),
}));

vi.mock("./client", () => ({
  vincentClient: vincentClientMock,
}));

import { VincentTuiView } from "./VincentAppView";
import { interact } from "./VincentAppView.interact";

const sampleStatus = {
  connected: true,
  connectedAt: 1_700_000_000_000,
  tradingVenues: ["hyperliquid", "polymarket"],
};

const sampleAddresses = {
  evm: "0x1234567890abcdef",
  solana: "So11111111111111111111111111111111111111112",
};

const sampleBalances = {
  evm: [],
  solana: [],
};

const sampleStrategy = {
  connected: true,
  strategy: {
    name: "threshold",
    venues: ["hyperliquid", "polymarket"],
    params: { maxPositionUsd: 100 },
    intervalSeconds: 60,
    dryRun: true,
    running: false,
  },
};

const sampleProfile = {
  connected: true,
  profile: {
    totalPnl: "12.50",
    winRate: 0.67,
    totalSwaps: 3,
    volume24h: "1000",
    tokenBreakdown: [{ symbol: "BTC", pnl: "10.00", swaps: 2 }],
  },
};

function mockState() {
  vincentClientMock.vincentStatus.mockResolvedValue(sampleStatus);
  vincentClientMock.getWalletAddresses.mockResolvedValue(sampleAddresses);
  vincentClientMock.getWalletBalances.mockResolvedValue(sampleBalances);
  vincentClientMock.vincentStrategy.mockResolvedValue(sampleStrategy);
  vincentClientMock.vincentTradingProfile.mockResolvedValue(sampleProfile);
  vincentClientMock.vincentStartLogin.mockResolvedValue({
    authUrl: "https://heyvincent.ai/oauth",
    state: "state-1",
    redirectUri: "http://localhost/callback/vincent",
  });
  vincentClientMock.vincentDisconnect.mockResolvedValue({ ok: true });
  vincentClientMock.vincentUpdateStrategy.mockResolvedValue({
    ok: true,
    strategy: sampleStrategy.strategy,
  });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("VincentTuiView", () => {
  it("mounts auth, wallet, strategy, profile, and TUI metadata", async () => {
    mockState();

    const { container } = render(React.createElement(VincentTuiView));

    await screen.findByText(/0x1234567890abcdef/);
    expect(screen.getByText("BTC pnl 10.00 swaps 2")).toBeTruthy();
    expect(vincentClientMock.vincentStatus).toHaveBeenCalled();
    expect(vincentClientMock.vincentStrategy).toHaveBeenCalled();

    const stateElement = container.querySelector("[data-view-state]");
    expect(
      JSON.parse(stateElement?.getAttribute("data-view-state") ?? "{}"),
    ).toMatchObject({
      viewType: "tui",
      viewId: "vincent",
      connected: true,
      connectedAt: 1_700_000_000_000,
      venues: ["hyperliquid", "polymarket"],
      evmAddress: "0x1234567890abcdef",
      solanaAddress: "So11111111111111111111111111111111111111112",
      strategyName: "threshold",
      strategyRunning: false,
      dryRun: true,
      totalPnl: "12.50",
    });
  });

  it("supports terminal capabilities for state, login, disconnect, and strategy updates", async () => {
    mockState();

    await expect(interact("terminal-vincent-state")).resolves.toMatchObject({
      viewType: "tui",
      status: sampleStatus,
      walletAddresses: sampleAddresses,
      walletBalances: sampleBalances,
      strategy: sampleStrategy,
      tradingProfile: sampleProfile,
    });

    await expect(
      interact("terminal-vincent-start-login", { appName: "Eliza Test" }),
    ).resolves.toMatchObject({
      viewType: "tui",
      login: { authUrl: "https://heyvincent.ai/oauth" },
    });
    expect(vincentClientMock.vincentStartLogin).toHaveBeenCalledWith(
      "Eliza Test",
    );

    await expect(interact("terminal-vincent-disconnect")).resolves.toEqual({
      viewType: "tui",
      disconnected: { ok: true },
    });

    await expect(
      interact("terminal-vincent-update-strategy", {
        strategy: "threshold",
        params: { maxPositionUsd: 100 },
        intervalSeconds: 60,
        dryRun: true,
      }),
    ).resolves.toEqual({
      viewType: "tui",
      update: { ok: true, strategy: sampleStrategy.strategy },
    });
    expect(vincentClientMock.vincentUpdateStrategy).toHaveBeenCalledWith({
      strategy: "threshold",
      params: { maxPositionUsd: 100 },
      intervalSeconds: 60,
      dryRun: true,
    });
  });
});
