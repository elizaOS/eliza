// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { clientMock, confirmDesktopActionMock, persistenceMock } = vi.hoisted(
  () => ({
    clientMock: {
      updateWalletConfig: vi.fn(async () => ({ ok: true })),
      refreshCloudWallets: vi.fn(async () => ({ ok: true })),
      generateWallet: vi.fn(async () => ({ ok: true, wallets: [] })),
      setWalletPrimary: vi.fn(async () => ({ ok: true })),
      getWalletConfig: vi.fn(async () => ({
        evmAddress: null,
        solanaAddress: null,
      })),
      getWalletBalances: vi.fn(async () => ({
        evm: null,
        solana: null,
      })),
    },
    confirmDesktopActionMock: vi.fn(),
    persistenceMock: {
      loadBrowserEnabled: vi.fn(() => false),
      loadComputerUseEnabled: vi.fn(() => false),
      loadWalletEnabled: vi.fn(() => true),
      saveBrowserEnabled: vi.fn(),
      saveComputerUseEnabled: vi.fn(),
      saveWalletEnabled: vi.fn(),
    },
  }),
);

vi.mock("../api", () => ({
  client: clientMock,
}));

vi.mock("../utils", () => ({
  confirmDesktopAction: confirmDesktopActionMock,
}));

vi.mock("./persistence", () => persistenceMock);

import { useWalletState } from "./useWalletState";

function createParams() {
  return {
    setActionNotice: vi.fn(),
    promptModal: vi.fn(async () => null),
    agentName: "Satoshi",
    characterName: "Satoshi",
  };
}

describe("useWalletState cloud wallet import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clientMock.updateWalletConfig.mockResolvedValue({ ok: true });
    clientMock.refreshCloudWallets.mockResolvedValue({ ok: true });
    clientMock.generateWallet.mockResolvedValue({ ok: true, wallets: [] });
    clientMock.setWalletPrimary.mockResolvedValue({ ok: true });
    clientMock.getWalletConfig.mockResolvedValue({
      evmAddress: null,
      solanaAddress: null,
    });
    clientMock.getWalletBalances.mockResolvedValue({
      evm: null,
      solana: null,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("refreshes cloud wallets after saving Eliza Cloud RPC selections", async () => {
    const params = createParams();
    const { result } = renderHook(() => useWalletState(params));

    await act(async () => {
      const saved = await result.current.handleWalletApiKeySave({
        selections: {
          evm: "eliza-cloud",
          bsc: "eliza-cloud",
          solana: "eliza-cloud",
        },
        walletNetwork: "mainnet",
      });
      expect(saved).toBe(true);
    });

    expect(clientMock.updateWalletConfig).toHaveBeenCalledTimes(1);
    expect(clientMock.refreshCloudWallets).toHaveBeenCalledTimes(1);
    await waitFor(() => {
      expect(params.setActionNotice).toHaveBeenCalledWith(
        "Cloud wallet import queued.",
        "success",
      );
    });
  });

  it("does not refresh cloud wallets for non-cloud RPC saves", async () => {
    const params = createParams();
    const { result } = renderHook(() => useWalletState(params));

    await act(async () => {
      const saved = await result.current.handleWalletApiKeySave({
        selections: {
          evm: "alchemy",
          bsc: "ankr",
          solana: "helius-birdeye",
        },
        walletNetwork: "mainnet",
      });
      expect(saved).toBe(true);
    });

    expect(clientMock.updateWalletConfig).toHaveBeenCalledTimes(1);
    expect(clientMock.refreshCloudWallets).not.toHaveBeenCalled();
  });

  it("surfaces partial cloud import warnings without failing the save", async () => {
    clientMock.refreshCloudWallets.mockResolvedValue({
      ok: true,
      warnings: ["Cloud solana wallet import failed: Validation error"],
    });
    clientMock.getWalletConfig.mockResolvedValue({
      evmAddress: "0xCLOUD_EVM",
      solanaAddress: null,
      wallets: [
        {
          source: "cloud",
          chain: "evm",
          address: "0xCLOUD_EVM",
          provider: "privy",
          primary: true,
        },
      ],
      primary: {
        evm: "cloud",
        solana: "local",
      },
    });
    const params = createParams();
    const { result } = renderHook(() => useWalletState(params));

    await act(async () => {
      const saved = await result.current.handleWalletApiKeySave({
        selections: {
          evm: "eliza-cloud",
          bsc: "eliza-cloud",
          solana: "eliza-cloud",
        },
        walletNetwork: "mainnet",
      });
      expect(saved).toBe(true);
    });

    await waitFor(() => {
      expect(params.setActionNotice).toHaveBeenCalledWith(
        "EVM cloud wallet connected. Solana cloud wallet is unavailable because Validation error.",
        "info",
      );
    });
  });

  it("translates the legacy Solana contract error into a clearer notice", async () => {
    clientMock.refreshCloudWallets.mockResolvedValue({
      ok: true,
      warnings: [
        "Cloud solana wallet import failed: Validation error: Invalid Solana address (base58, 32–44 chars)",
      ],
    });
    clientMock.getWalletConfig.mockResolvedValue({
      evmAddress: "0xCLOUD_EVM",
      solanaAddress: null,
      wallets: [
        {
          source: "cloud",
          chain: "evm",
          address: "0xCLOUD_EVM",
          provider: "privy",
          primary: true,
        },
      ],
      primary: {
        evm: "cloud",
        solana: "local",
      },
    });
    const params = createParams();
    const { result } = renderHook(() => useWalletState(params));

    await act(async () => {
      const saved = await result.current.handleWalletApiKeySave({
        selections: {
          evm: "eliza-cloud",
          bsc: "eliza-cloud",
          solana: "eliza-cloud",
        },
        walletNetwork: "mainnet",
      });
      expect(saved).toBe(true);
    });

    await waitFor(() => {
      expect(params.setActionNotice).toHaveBeenCalledWith(
        "EVM cloud wallet connected. Solana cloud wallet is unavailable because the connected Eliza Cloud backend is still using the legacy Solana wallet contract.",
        "info",
      );
    });
  });

  it("treats cached-evm plus imported-solana as connected when both cloud wallets are present", async () => {
    clientMock.refreshCloudWallets.mockResolvedValue({
      ok: true,
      warnings: [
        "Reused cached evm cloud wallet after refresh failed: An unexpected error occurred",
      ],
    });
    clientMock.getWalletConfig.mockResolvedValue({
      evmAddress: "0xCLOUD_EVM",
      solanaAddress: "So11111111111111111111111111111111111111112",
      wallets: [
        {
          source: "cloud",
          chain: "evm",
          address: "0xCLOUD_EVM",
          provider: "privy",
          primary: true,
        },
        {
          source: "cloud",
          chain: "solana",
          address: "So11111111111111111111111111111111111111112",
          provider: "steward",
          primary: true,
        },
      ],
      primary: {
        evm: "cloud",
        solana: "cloud",
      },
    });
    const params = createParams();
    const { result } = renderHook(() => useWalletState(params));

    await act(async () => {
      const saved = await result.current.handleWalletApiKeySave({
        selections: {
          evm: "eliza-cloud",
          bsc: "eliza-cloud",
          solana: "eliza-cloud",
        },
        walletNetwork: "mainnet",
      });
      expect(saved).toBe(true);
    });

    await waitFor(() => {
      expect(params.setActionNotice).toHaveBeenCalledWith(
        "Cloud wallets connected.",
        "success",
      );
    });
  });

  it("provisions a missing local wallet before switching primary", async () => {
    clientMock.getWalletConfig
      .mockResolvedValueOnce({
        evmAddress: "0xCLOUD_EVM",
        solanaAddress: "So11111111111111111111111111111111111111112",
        wallets: [
          {
            source: "cloud",
            chain: "evm",
            address: "0xCLOUD_EVM",
            provider: "privy",
            primary: true,
          },
          {
            source: "local",
            chain: "solana",
            address: "So11111111111111111111111111111111111111112",
            provider: "local",
            primary: true,
          },
        ],
        primary: {
          evm: "cloud",
          solana: "local",
        },
      })
      .mockResolvedValueOnce({
        evmAddress: "0xLOCAL_EVM",
        solanaAddress: "So11111111111111111111111111111111111111112",
        wallets: [
          {
            source: "local",
            chain: "evm",
            address: "0xLOCAL_EVM",
            provider: "local",
            primary: false,
          },
          {
            source: "cloud",
            chain: "evm",
            address: "0xCLOUD_EVM",
            provider: "privy",
            primary: true,
          },
          {
            source: "local",
            chain: "solana",
            address: "So11111111111111111111111111111111111111112",
            provider: "local",
            primary: true,
          },
        ],
        primary: {
          evm: "cloud",
          solana: "local",
        },
      })
      .mockResolvedValue({
        evmAddress: "0xLOCAL_EVM",
        solanaAddress: "So11111111111111111111111111111111111111112",
        wallets: [
          {
            source: "local",
            chain: "evm",
            address: "0xLOCAL_EVM",
            provider: "local",
            primary: true,
          },
          {
            source: "cloud",
            chain: "evm",
            address: "0xCLOUD_EVM",
            provider: "privy",
            primary: false,
          },
          {
            source: "local",
            chain: "solana",
            address: "So11111111111111111111111111111111111111112",
            provider: "local",
            primary: true,
          },
        ],
        primary: {
          evm: "local",
          solana: "local",
        },
      });
    clientMock.generateWallet.mockResolvedValue({
      ok: true,
      wallets: [{ chain: "evm", address: "0xLOCAL_EVM" }],
      source: "local",
    });
    const params = createParams();
    const { result } = renderHook(() => useWalletState(params));

    await act(async () => {
      await result.current.setPrimary("evm", "local");
    });

    expect(clientMock.generateWallet).toHaveBeenCalledWith({
      chain: "evm",
      source: "local",
    });
    expect(clientMock.setWalletPrimary).toHaveBeenCalledWith({
      chain: "evm",
      source: "local",
    });
  });

  it("refreshes cloud wallets before switching to a missing cloud source", async () => {
    clientMock.getWalletConfig
      .mockResolvedValueOnce({
        evmAddress: "0xCLOUD_EVM",
        solanaAddress: "So11111111111111111111111111111111111111112",
        wallets: [
          {
            source: "cloud",
            chain: "evm",
            address: "0xCLOUD_EVM",
            provider: "privy",
            primary: true,
          },
          {
            source: "local",
            chain: "solana",
            address: "So11111111111111111111111111111111111111112",
            provider: "local",
            primary: true,
          },
        ],
        primary: {
          evm: "cloud",
          solana: "local",
        },
      })
      .mockResolvedValueOnce({
        evmAddress: "0xCLOUD_EVM",
        solanaAddress: "SoCloud1111111111111111111111111111111111111",
        wallets: [
          {
            source: "cloud",
            chain: "evm",
            address: "0xCLOUD_EVM",
            provider: "privy",
            primary: true,
          },
          {
            source: "local",
            chain: "solana",
            address: "So11111111111111111111111111111111111111112",
            provider: "local",
            primary: true,
          },
          {
            source: "cloud",
            chain: "solana",
            address: "SoCloud1111111111111111111111111111111111111",
            provider: "steward",
            primary: false,
          },
        ],
        primary: {
          evm: "cloud",
          solana: "local",
        },
      })
      .mockResolvedValue({
        evmAddress: "0xCLOUD_EVM",
        solanaAddress: "SoCloud1111111111111111111111111111111111111",
        wallets: [
          {
            source: "cloud",
            chain: "evm",
            address: "0xCLOUD_EVM",
            provider: "privy",
            primary: true,
          },
          {
            source: "local",
            chain: "solana",
            address: "So11111111111111111111111111111111111111112",
            provider: "local",
            primary: false,
          },
          {
            source: "cloud",
            chain: "solana",
            address: "SoCloud1111111111111111111111111111111111111",
            provider: "steward",
            primary: true,
          },
        ],
        primary: {
          evm: "cloud",
          solana: "cloud",
        },
      });
    clientMock.refreshCloudWallets.mockResolvedValue({
      ok: true,
      warnings: [],
    });
    const params = createParams();
    const { result } = renderHook(() => useWalletState(params));

    await act(async () => {
      await result.current.setPrimary("solana", "cloud");
    });

    expect(clientMock.refreshCloudWallets).toHaveBeenCalled();
    expect(clientMock.setWalletPrimary).toHaveBeenCalledWith({
      chain: "solana",
      source: "cloud",
    });
  });
});
