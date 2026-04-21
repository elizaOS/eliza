// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ButtonHTMLAttributes } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StewardVaultOverview } from "./StewardVaultOverview";

vi.mock("@miladyai/ui", () => ({
  Button: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
}));

function createBalance(chainId: number, formatted: string, symbol: string) {
  return {
    balance: "1000000000000000000",
    formatted,
    symbol,
    chainId,
  };
}

describe("StewardVaultOverview", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("loads steward vault surfaces and refreshes them on demand", async () => {
    const getStewardAddresses = vi.fn().mockResolvedValue({
      evmAddress: "0x1234567890abcdef1234567890abcdef12345678",
      solanaAddress: "7xKXtg2CW4VjQ4v8P9C3LFQ69sNQvW2en9w1K7cA7YqL",
    });
    const getStewardBalance = vi.fn((chainId?: number) => {
      switch (chainId) {
        case 1:
          return Promise.resolve(createBalance(1, "1.25 ETH", "ETH"));
        case 56:
          return Promise.resolve(createBalance(56, "4.20 BNB", "BNB"));
        case 8453:
          return Promise.resolve(createBalance(8453, "0.33 ETH", "ETH"));
        case 101:
          return Promise.resolve(createBalance(101, "9.10 SOL", "SOL"));
        default:
          throw new Error(`unexpected chain ${chainId}`);
      }
    });
    const getStewardTokens = vi.fn((chainId?: number) => {
      if (chainId === 101) {
        return Promise.resolve({
          native: createBalance(101, "9.10 SOL", "SOL"),
          tokens: [
            {
              address: "So11111111111111111111111111111111111111112",
              symbol: "USDC",
              name: "USD Coin",
              balance: "10",
              formatted: "10",
              decimals: 6,
            },
          ],
        });
      }

      return Promise.resolve({
        native: createBalance(chainId ?? 0, "1.00", "ETH"),
        tokens: [
          {
            address: "0xfeed",
            symbol: "USDC",
            name: "USD Coin",
            balance: "100",
            formatted: "100",
            decimals: 6,
          },
          {
            address: "0xbeef",
            symbol: "WETH",
            name: "Wrapped Ether",
            balance: "2",
            formatted: "2",
            decimals: 18,
          },
        ],
      });
    });
    const getStewardWebhookEvents = vi.fn().mockResolvedValue({
      events: [
        {
          event: "tx.confirmed",
          timestamp: "2026-04-13T01:23:00.000Z",
          data: { txHash: "0x1234567890abcdef1234567890abcdef12345678" },
        },
      ],
      nextIndex: 1,
    });
    const copyToClipboard = vi.fn().mockResolvedValue(undefined);
    const setActionNotice = vi.fn();

    render(
      <StewardVaultOverview
        stewardStatus={{
          configured: true,
          available: true,
          connected: true,
          evmAddress: "0x1234567890abcdef1234567890abcdef12345678",
          walletAddresses: {
            evm: "0x1234567890abcdef1234567890abcdef12345678",
            solana: "7xKXtg2CW4VjQ4v8P9C3LFQ69sNQvW2en9w1K7cA7YqL",
          },
          agentId: "agent-1234",
          vaultHealth: "ok",
        }}
        getStewardAddresses={getStewardAddresses}
        getStewardBalance={getStewardBalance}
        getStewardTokens={getStewardTokens}
        getStewardWebhookEvents={getStewardWebhookEvents}
        copyToClipboard={copyToClipboard}
        setActionNotice={setActionNotice}
      />,
    );

    await waitFor(() => {
      expect(getStewardAddresses).toHaveBeenCalledTimes(1);
    });

    expect(screen.getByText("Steward vault overview")).toBeTruthy();
    expect(screen.getByText("EVM Address")).toBeTruthy();
    expect(screen.getByText("Solana Address")).toBeTruthy();
    expect(screen.getByText("Ethereum")).toBeTruthy();
    expect(screen.getByText("1.25 ETH")).toBeTruthy();
    expect(screen.getByText("4.20 BNB")).toBeTruthy();
    expect(screen.getByText("9.10 SOL")).toBeTruthy();
    expect(screen.getByText("Confirmed")).toBeTruthy();

    expect(getStewardBalance).toHaveBeenCalledWith(1);
    expect(getStewardBalance).toHaveBeenCalledWith(56);
    expect(getStewardBalance).toHaveBeenCalledWith(8453);
    expect(getStewardBalance).toHaveBeenCalledWith(101);

    fireEvent.click(screen.getByRole("button", { name: "Copy EVM Address" }));
    await waitFor(() => {
      expect(copyToClipboard).toHaveBeenCalledWith(
        "0x1234567890abcdef1234567890abcdef12345678",
      );
    });
    expect(setActionNotice).toHaveBeenCalledWith(
      "EVM Address copied",
      "success",
      2000,
    );

    fireEvent.click(screen.getByRole("button", { name: "Refresh vault" }));
    await waitFor(() => {
      expect(getStewardAddresses).toHaveBeenCalledTimes(2);
    });
  });
});
