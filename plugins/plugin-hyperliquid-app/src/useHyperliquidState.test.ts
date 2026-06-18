// @vitest-environment jsdom
//
// Unit test for the useHyperliquidState hook in isolation from the view.
// Drives the four read endpoints through a mocked patched ElizaClient and
// asserts: success populates all four slices and clears loading; publicReadReady
// =false leaves markets/positions/orders null and skips the three read calls;
// a rejection sets error and clears loading; refresh() re-invokes the reads.

import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
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

vi.mock("@elizaos/app-core", () => ({ client: hyperliquidClient }));
vi.mock("./client", () => ({}));

import { useHyperliquidState } from "./useHyperliquidState";

const status: HyperliquidStatusResponse = {
  publicReadReady: true,
  signerReady: false,
  executionReady: false,
  executionBlockedReason: null,
  accountAddress: "0xabc",
  apiBaseUrl: "https://api.hyperliquid.xyz",
  credentialMode: "none",
  readiness: {
    publicReads: true,
    accountReads: true,
    signer: false,
    execution: false,
  },
  account: { address: "0xabc", source: "env_account", guidance: null },
  vault: { configured: false, ready: false, address: null, guidance: "g" },
  apiWallet: { configured: false, guidance: "g" },
};

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
  ],
  source: "hyperliquid-info-meta",
  fetchedAt: "2026-05-18T12:00:00.000Z",
};

const positions: HyperliquidPositionsResponse = {
  accountAddress: "0xabc",
  positions: [],
  readBlockedReason: null,
  fetchedAt: "2026-05-18T12:00:00.000Z",
};

const orders: HyperliquidOrdersResponse = {
  accountAddress: "0xabc",
  orders: [],
  readBlockedReason: null,
  fetchedAt: "2026-05-18T12:00:00.000Z",
};

afterEach(() => {
  vi.clearAllMocks();
});

describe("useHyperliquidState", () => {
  it("populates all four slices on success and clears loading", async () => {
    hyperliquidClient.hyperliquidStatus.mockResolvedValue(status);
    hyperliquidClient.hyperliquidMarkets.mockResolvedValue(markets);
    hyperliquidClient.hyperliquidPositions.mockResolvedValue(positions);
    hyperliquidClient.hyperliquidOrders.mockResolvedValue(orders);

    const { result } = renderHook(() => useHyperliquidState());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.status).toEqual(status);
    expect(result.current.markets).toEqual(markets);
    expect(result.current.positions).toEqual(positions);
    expect(result.current.orders).toEqual(orders);
    expect(result.current.error).toBeNull();
  });

  it("leaves markets/positions/orders null and skips the reads when publicReadReady is false", async () => {
    hyperliquidClient.hyperliquidStatus.mockResolvedValue({
      ...status,
      publicReadReady: false,
    });

    const { result } = renderHook(() => useHyperliquidState());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.status?.publicReadReady).toBe(false);
    expect(result.current.markets).toBeNull();
    expect(result.current.positions).toBeNull();
    expect(result.current.orders).toBeNull();
    expect(hyperliquidClient.hyperliquidMarkets).not.toHaveBeenCalled();
    expect(hyperliquidClient.hyperliquidPositions).not.toHaveBeenCalled();
    expect(hyperliquidClient.hyperliquidOrders).not.toHaveBeenCalled();
  });

  it("sets error to the rejection message and clears loading", async () => {
    hyperliquidClient.hyperliquidStatus.mockRejectedValue(
      new Error("status fetch failed"),
    );

    const { result } = renderHook(() => useHyperliquidState());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(result.current.error).toBe("status fetch failed");
    expect(result.current.status).toBeNull();
  });

  it("re-invokes the reads when refresh() is called", async () => {
    hyperliquidClient.hyperliquidStatus.mockResolvedValue(status);
    hyperliquidClient.hyperliquidMarkets.mockResolvedValue(markets);
    hyperliquidClient.hyperliquidPositions.mockResolvedValue(positions);
    hyperliquidClient.hyperliquidOrders.mockResolvedValue(orders);

    const { result } = renderHook(() => useHyperliquidState());
    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });
    expect(hyperliquidClient.hyperliquidStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      await result.current.refresh();
    });

    expect(hyperliquidClient.hyperliquidStatus).toHaveBeenCalledTimes(2);
    expect(hyperliquidClient.hyperliquidMarkets).toHaveBeenCalledTimes(2);
    expect(hyperliquidClient.hyperliquidPositions).toHaveBeenCalledTimes(2);
    expect(hyperliquidClient.hyperliquidOrders).toHaveBeenCalledTimes(2);
  });
});
