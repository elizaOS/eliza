// @vitest-environment jsdom

import type {
  StewardBalanceResponse,
  StewardTokenBalancesResponse,
  StewardWalletAddressesResponse,
  StewardWebhookEventsResponse,
} from "@elizaos/core";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@elizaos/ui", () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) =>
    React.createElement("button", props, children),
}));

import { StewardVaultOverview } from "./StewardVaultOverview";
import type { StewardStatusResponse } from "./types/steward";

const EVM = "0x1234567890abcdef1234567890abcdef12345678";
const SOL = "SoLaNaAddr1111111111111111111111111111111";

const status: StewardStatusResponse = {
  configured: true,
  available: true,
  connected: true,
  agentId: "agent-alpha-1234",
  evmAddress: EVM,
  error: null,
  walletAddresses: { evm: EVM, solana: SOL },
  vaultHealth: "ok",
};

function makeProps(
  overrides: Partial<{
    vaultHealth: StewardStatusResponse["vaultHealth"];
    addresses: StewardWalletAddressesResponse;
    events: StewardWebhookEventsResponse;
    balanceReject: boolean;
  }> = {},
) {
  const addresses: StewardWalletAddressesResponse = overrides.addresses ?? {
    evmAddress: EVM,
    solanaAddress: SOL,
  };
  const getStewardAddresses = vi.fn(async () => addresses);
  const getStewardBalance = vi.fn(
    async (chainId?: number): Promise<StewardBalanceResponse> => {
      if (overrides.balanceReject) throw new Error("rpc method is unsupported");
      return {
        balance: "1000000000000000000",
        formatted: chainId === 101 ? "3.2 SOL" : "1.5 ETH",
        symbol: chainId === 101 ? "SOL" : "ETH",
        chainId: chainId ?? 1,
      };
    },
  );
  const getStewardTokens = vi.fn(
    async (chainId?: number): Promise<StewardTokenBalancesResponse> => ({
      native: {
        balance: "1000000000000000000",
        formatted: "1.5",
        symbol: chainId === 101 ? "SOL" : "ETH",
        chainId: chainId ?? 1,
      },
      tokens: [
        {
          address: "0xusdc",
          symbol: "USDC",
          name: "USD Coin",
          balance: "5000000",
          formatted: "5.0",
          decimals: 6,
        },
        {
          address: "0xdai",
          symbol: "DAI",
          name: "Dai",
          balance: "2000000000000000000",
          formatted: "2.0",
          decimals: 18,
        },
      ],
    }),
  );
  const events: StewardWebhookEventsResponse = overrides.events ?? {
    events: [
      {
        event: "tx.pending",
        timestamp: "2026-05-18T10:00:00.000Z",
        data: { txId: "req-oldest" },
      },
      {
        event: "tx.confirmed",
        timestamp: "2026-05-18T12:00:00.000Z",
        data: { txHash: "0xconfirmedhash" },
      },
    ],
    nextIndex: 2,
  };
  const getStewardWebhookEvents = vi.fn(async () => events);

  return {
    stewardStatus: { ...status, vaultHealth: overrides.vaultHealth ?? "ok" },
    getStewardAddresses,
    getStewardBalance,
    getStewardTokens,
    getStewardWebhookEvents,
    copyToClipboard: vi.fn(async () => {}),
    setActionNotice: vi.fn(),
  };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("StewardVaultOverview — populated data", () => {
  it("renders address cards, per-chain balances/token counts, symbols, and newest-first events", async () => {
    const props = makeProps();
    render(React.createElement(StewardVaultOverview, props));

    // Vault health (ok branch).
    expect(await screen.findByText("Vault connected and ready")).toBeTruthy();

    // Address cards (full addresses shown, break-all).
    expect(screen.getByText("EVM Address")).toBeTruthy();
    expect(screen.getByText("Solana Address")).toBeTruthy();
    expect(screen.getAllByText(EVM).length).toBeGreaterThan(0);
    expect(screen.getByText(SOL)).toBeTruthy();

    // Per-chain balance snapshots: the three EVM overview chains
    // (Ethereum/BSC/Base) all read the evm balance "1.5 ETH".
    expect((await screen.findAllByText("1.5 ETH")).length).toBe(3);
    // Solana chain shows its formatted balance.
    expect(screen.getByText("3.2 SOL")).toBeTruthy();
    // Token count text + token symbols.
    expect(screen.getAllByText("2 tracked tokens").length).toBeGreaterThan(0);
    expect(screen.getAllByText("USDC, DAI").length).toBeGreaterThan(0);

    // Recent vault events, newest first: confirmed (12:00) before pending (10:00).
    const confirmed = screen.getByText("Confirmed");
    const pending = screen.getByText("Pending approval");
    expect(confirmed).toBeTruthy();
    expect(pending).toBeTruthy();
    expect(
      confirmed.compareDocumentPosition(pending) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Event reference extracted from tx hash (truncateAddress(hash, 4)).
    expect(screen.getByText("Tx 0xconf…hash")).toBeTruthy();

    // Snapshots loaded for the four overview chains that have addresses
    // (Ethereum/BSC/Base via evm + Solana). Balance loader called per chain.
    expect(props.getStewardBalance).toHaveBeenCalled();
  });

  it("renders the degraded and error vault-health branches", async () => {
    const degraded = makeProps({ vaultHealth: "degraded" });
    const { unmount } = render(
      React.createElement(StewardVaultOverview, degraded),
    );
    expect(
      await screen.findByText("Vault healthy enough to use"),
    ).toBeTruthy();
    unmount();

    const errored = makeProps({ vaultHealth: "error" });
    render(React.createElement(StewardVaultOverview, errored));
    expect(await screen.findByText("Vault needs attention")).toBeTruthy();
  });

  it("surfaces a per-chain error message when balance + tokens both reject", async () => {
    const props = makeProps({ balanceReject: true });
    // Make tokens reject too so the snapshot records an error.
    props.getStewardTokens = vi.fn(async () => {
      throw new Error("rpc method is unsupported");
    });
    render(React.createElement(StewardVaultOverview, props));

    expect(
      await screen.findAllByText("Chain RPC is temporarily unavailable."),
    ).toBeTruthy();
  });
});

describe("StewardVaultOverview — controls", () => {
  it("copies an address via the per-card copy button", async () => {
    const props = makeProps();
    render(React.createElement(StewardVaultOverview, props));

    const copyBtn = await screen.findByRole("button", {
      name: "Copy EVM Address",
    });
    await act(async () => {
      fireEvent.click(copyBtn);
    });
    expect(props.copyToClipboard).toHaveBeenCalledWith(EVM);
    expect(props.setActionNotice).toHaveBeenCalledWith(
      "EVM Address copied",
      "success",
      2000,
    );
  });

  it("Refresh vault re-invokes the loaders", async () => {
    const props = makeProps();
    render(React.createElement(StewardVaultOverview, props));
    await screen.findByText("Vault connected and ready");
    const addrCallsBefore = props.getStewardAddresses.mock.calls.length;
    const eventCallsBefore = props.getStewardWebhookEvents.mock.calls.length;

    await act(async () => {
      fireEvent.click(screen.getByText("Refresh vault"));
    });

    expect(props.getStewardAddresses.mock.calls.length).toBeGreaterThan(
      addrCallsBefore,
    );
    expect(props.getStewardWebhookEvents.mock.calls.length).toBeGreaterThan(
      eventCallsBefore,
    );
  });
});
