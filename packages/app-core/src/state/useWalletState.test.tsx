// @vitest-environment jsdom

import {
  DEFAULT_WALLET_RPC_SELECTIONS,
  type WalletBalancesResponse,
  type WalletChainKind,
  type WalletConfigStatus,
  type WalletEntry,
  type WalletPrimaryMap,
} from "@elizaos/shared";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type RefreshCloudWalletsResponse = {
  ok: boolean;
  warnings?: string[];
};

type GenerateWalletResponse = {
  ok: boolean;
  wallets: Array<{ chain: WalletChainKind; address: string }>;
  source?: "local" | "steward";
  warnings?: string[];
};

function createWalletEntry(entry: WalletEntry): WalletEntry {
  return entry;
}

function createWalletPrimary(
  overrides: Partial<WalletPrimaryMap> = {},
): WalletPrimaryMap {
  return {
    evm: "local",
    solana: "local",
    ...overrides,
  };
}

function createWalletConfig(
  overrides: Partial<WalletConfigStatus> = {},
): WalletConfigStatus {
  return {
    selectedRpcProviders: DEFAULT_WALLET_RPC_SELECTIONS,
    legacyCustomChains: [],
    alchemyKeySet: false,
    infuraKeySet: false,
    ankrKeySet: false,
    heliusKeySet: false,
    birdeyeKeySet: false,
    evmChains: [],
    evmAddress: null,
    solanaAddress: null,
    ...overrides,
  };
}

function createWalletBalances(
  overrides: Partial<WalletBalancesResponse> = {},
): WalletBalancesResponse {
  return {
    evm: null,
    solana: null,
    ...overrides,
  };
}

function createRefreshCloudWalletsResponse(
  overrides: Partial<RefreshCloudWalletsResponse> = {},
): RefreshCloudWalletsResponse {
  return {
    ok: true,
    ...overrides,
  };
}

function createGenerateWalletResponse(
  overrides: Partial<GenerateWalletResponse> = {},
): GenerateWalletResponse {
  return {
    ok: true,
    wallets: [],
    ...overrides,
  };
}

const { clientMock, confirmDesktopActionMock, persistenceMock } = vi.hoisted(
  () => ({
    clientMock: {
      getConfig: vi.fn<() => Promise<Record<string, unknown>>>(
        async () => ({}),
      ),
      updateConfig: vi.fn(async () => ({})),
      updateWalletConfig: vi.fn<() => Promise<{ ok: boolean }>>(async () => ({
        ok: true,
      })),
      refreshCloudWallets: vi.fn<() => Promise<RefreshCloudWalletsResponse>>(
        async () => createRefreshCloudWalletsResponse(),
      ),
      generateWallet: vi.fn<() => Promise<GenerateWalletResponse>>(async () =>
        createGenerateWalletResponse(),
      ),
      setWalletPrimary: vi.fn<() => Promise<{ ok: boolean }>>(async () => ({
        ok: true,
      })),
      getWalletConfig: vi.fn<() => Promise<WalletConfigStatus>>(async () =>
        createWalletConfig(),
      ),
      getWalletBalances: vi.fn<() => Promise<WalletBalancesResponse>>(
        async () => createWalletBalances(),
      ),
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
    persistenceMock.loadBrowserEnabled.mockReturnValue(false);
    persistenceMock.loadComputerUseEnabled.mockReturnValue(false);
    persistenceMock.loadWalletEnabled.mockReturnValue(true);
    clientMock.updateWalletConfig.mockResolvedValue({ ok: true });
    clientMock.refreshCloudWallets.mockResolvedValue(
      createRefreshCloudWalletsResponse(),
    );
    clientMock.generateWallet.mockResolvedValue(createGenerateWalletResponse());
    clientMock.setWalletPrimary.mockResolvedValue({ ok: true });
    clientMock.getConfig.mockResolvedValue({});
    clientMock.updateConfig.mockResolvedValue({});
    clientMock.getWalletConfig.mockResolvedValue(createWalletConfig());
    clientMock.getWalletBalances.mockResolvedValue(createWalletBalances());
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
    clientMock.refreshCloudWallets.mockResolvedValue(
      createRefreshCloudWalletsResponse({
        warnings: ["Cloud solana wallet import failed: Validation error"],
      }),
    );
    clientMock.getWalletConfig.mockResolvedValue(
      createWalletConfig({
        evmAddress: "0xCLOUD_EVM",
        wallets: [
          createWalletEntry({
            source: "cloud",
            chain: "evm",
            address: "0xCLOUD_EVM",
            provider: "privy",
            primary: true,
          }),
        ],
        primary: createWalletPrimary({
          evm: "cloud",
        }),
      }),
    );
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
    clientMock.refreshCloudWallets.mockResolvedValue(
      createRefreshCloudWalletsResponse({
        warnings: [
          "Cloud solana wallet import failed: Validation error: Invalid Solana address (base58, 32–44 chars)",
        ],
      }),
    );
    clientMock.getWalletConfig.mockResolvedValue(
      createWalletConfig({
        evmAddress: "0xCLOUD_EVM",
        wallets: [
          createWalletEntry({
            source: "cloud",
            chain: "evm",
            address: "0xCLOUD_EVM",
            provider: "privy",
            primary: true,
          }),
        ],
        primary: createWalletPrimary({
          evm: "cloud",
        }),
      }),
    );
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
    clientMock.refreshCloudWallets.mockResolvedValue(
      createRefreshCloudWalletsResponse({
        warnings: [
          "Reused cached evm cloud wallet after refresh failed: An unexpected error occurred",
        ],
      }),
    );
    clientMock.getWalletConfig.mockResolvedValue(
      createWalletConfig({
        evmAddress: "0xCLOUD_EVM",
        solanaAddress: "So11111111111111111111111111111111111111112",
        wallets: [
          createWalletEntry({
            source: "cloud",
            chain: "evm",
            address: "0xCLOUD_EVM",
            provider: "privy",
            primary: true,
          }),
          createWalletEntry({
            source: "cloud",
            chain: "solana",
            address: "So11111111111111111111111111111111111111112",
            provider: "steward",
            primary: true,
          }),
        ],
        primary: createWalletPrimary({
          evm: "cloud",
          solana: "cloud",
        }),
      }),
    );
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
      .mockResolvedValueOnce(
        createWalletConfig({
          evmAddress: "0xCLOUD_EVM",
          solanaAddress: "So11111111111111111111111111111111111111112",
          wallets: [
            createWalletEntry({
              source: "cloud",
              chain: "evm",
              address: "0xCLOUD_EVM",
              provider: "privy",
              primary: true,
            }),
            createWalletEntry({
              source: "local",
              chain: "solana",
              address: "So11111111111111111111111111111111111111112",
              provider: "local",
              primary: true,
            }),
          ],
          primary: createWalletPrimary({
            evm: "cloud",
          }),
        }),
      )
      .mockResolvedValueOnce(
        createWalletConfig({
          evmAddress: "0xLOCAL_EVM",
          solanaAddress: "So11111111111111111111111111111111111111112",
          wallets: [
            createWalletEntry({
              source: "local",
              chain: "evm",
              address: "0xLOCAL_EVM",
              provider: "local",
              primary: false,
            }),
            createWalletEntry({
              source: "cloud",
              chain: "evm",
              address: "0xCLOUD_EVM",
              provider: "privy",
              primary: true,
            }),
            createWalletEntry({
              source: "local",
              chain: "solana",
              address: "So11111111111111111111111111111111111111112",
              provider: "local",
              primary: true,
            }),
          ],
          primary: createWalletPrimary({
            evm: "cloud",
          }),
        }),
      )
      .mockResolvedValue(
        createWalletConfig({
          evmAddress: "0xLOCAL_EVM",
          solanaAddress: "So11111111111111111111111111111111111111112",
          wallets: [
            createWalletEntry({
              source: "local",
              chain: "evm",
              address: "0xLOCAL_EVM",
              provider: "local",
              primary: true,
            }),
            createWalletEntry({
              source: "cloud",
              chain: "evm",
              address: "0xCLOUD_EVM",
              provider: "privy",
              primary: false,
            }),
            createWalletEntry({
              source: "local",
              chain: "solana",
              address: "So11111111111111111111111111111111111111112",
              provider: "local",
              primary: true,
            }),
          ],
          primary: createWalletPrimary(),
        }),
      );
    clientMock.generateWallet.mockResolvedValue(
      createGenerateWalletResponse({
        wallets: [{ chain: "evm", address: "0xLOCAL_EVM" }],
        source: "local",
      }),
    );
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
      .mockResolvedValueOnce(
        createWalletConfig({
          evmAddress: "0xCLOUD_EVM",
          solanaAddress: "So11111111111111111111111111111111111111112",
          wallets: [
            createWalletEntry({
              source: "cloud",
              chain: "evm",
              address: "0xCLOUD_EVM",
              provider: "privy",
              primary: true,
            }),
            createWalletEntry({
              source: "local",
              chain: "solana",
              address: "So11111111111111111111111111111111111111112",
              provider: "local",
              primary: true,
            }),
          ],
          primary: createWalletPrimary({
            evm: "cloud",
          }),
        }),
      )
      .mockResolvedValueOnce(
        createWalletConfig({
          evmAddress: "0xCLOUD_EVM",
          solanaAddress: "SoCloud1111111111111111111111111111111111111",
          wallets: [
            createWalletEntry({
              source: "cloud",
              chain: "evm",
              address: "0xCLOUD_EVM",
              provider: "privy",
              primary: true,
            }),
            createWalletEntry({
              source: "local",
              chain: "solana",
              address: "So11111111111111111111111111111111111111112",
              provider: "local",
              primary: true,
            }),
            createWalletEntry({
              source: "cloud",
              chain: "solana",
              address: "SoCloud1111111111111111111111111111111111111",
              provider: "steward",
              primary: false,
            }),
          ],
          primary: createWalletPrimary({
            evm: "cloud",
          }),
        }),
      )
      .mockResolvedValue(
        createWalletConfig({
          evmAddress: "0xCLOUD_EVM",
          solanaAddress: "SoCloud1111111111111111111111111111111111111",
          wallets: [
            createWalletEntry({
              source: "cloud",
              chain: "evm",
              address: "0xCLOUD_EVM",
              provider: "privy",
              primary: true,
            }),
            createWalletEntry({
              source: "local",
              chain: "solana",
              address: "So11111111111111111111111111111111111111112",
              provider: "local",
              primary: false,
            }),
            createWalletEntry({
              source: "cloud",
              chain: "solana",
              address: "SoCloud1111111111111111111111111111111111111",
              provider: "steward",
              primary: true,
            }),
          ],
          primary: createWalletPrimary({
            evm: "cloud",
            solana: "cloud",
          }),
        }),
      );
    clientMock.refreshCloudWallets.mockResolvedValue(
      createRefreshCloudWalletsResponse({ warnings: [] }),
    );
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
