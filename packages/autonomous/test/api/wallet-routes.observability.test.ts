import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MiladyConfig } from "../../src/config/config";
import {
  handleWalletRoutes,
  type WalletRouteDependencies,
} from "../../src/api/wallet-routes";

const { createSpanMock, spanSuccessMock, spanFailureMock } = vi.hoisted(() => ({
  createSpanMock: vi.fn(),
  spanSuccessMock: vi.fn(),
  spanFailureMock: vi.fn(),
}));

vi.mock("../../src/diagnostics/integration-observability", () => ({
  createIntegrationTelemetrySpan: createSpanMock,
}));

const ENV_KEYS = [
  "ALCHEMY_API_KEY",
  "HELIUS_API_KEY",
  "ELIZAOS_CLOUD_API_KEY",
  "SOLANA_RPC_URL",
] as const;
const ORIGINAL_ENV = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

function baseDeps(): WalletRouteDependencies {
  return {
    getWalletAddresses: vi.fn(() => ({
      evmAddress: "0xabc",
      solanaAddress: "So111",
    })),
    fetchEvmBalances: vi.fn(async () => []),
    fetchSolanaBalances: vi.fn(async () => ({
      solBalance: "1",
      solValueUsd: "100",
      tokens: [],
    })),
    fetchSolanaNativeBalanceViaRpc: vi.fn(async () => ({
      solBalance: "0.5",
      solValueUsd: "0",
      tokens: [],
    })),
    fetchEvmNfts: vi.fn(async () => []),
    fetchSolanaNfts: vi.fn(async () => []),
    validatePrivateKey: vi.fn(() => ({
      valid: true,
      chain: "evm" as const,
      address: "0xabc",
      error: null,
    })),
    importWallet: vi.fn(() => ({
      success: true,
      chain: "evm" as const,
      address: "0xabc",
      error: null,
    })),
    generateWalletForChain: vi.fn((chain) => ({
      chain,
      address: chain === "evm" ? "0xgenerated" : "SoGenerated",
      privateKey: chain === "evm" ? "evm-key" : "sol-key",
    })),
  };
}

function walletRouteCtx(
  pathname: string,
  deps: WalletRouteDependencies,
): Parameters<typeof handleWalletRoutes>[0] {
  return {
    req: {} as never,
    res: {} as never,
    method: "GET",
    pathname,
    config: { env: {} } as MiladyConfig,
    saveConfig: vi.fn(),
    ensureWalletKeysInEnvAndConfig: vi.fn(),
    resolveWalletExportRejection: () => null,
    deps,
    readJsonBody: vi.fn(async () => null),
    json: vi.fn(),
    error: vi.fn(),
  };
}

async function invokeBalances(deps: WalletRouteDependencies): Promise<void> {
  await handleWalletRoutes(walletRouteCtx("/api/wallet/balances", deps));
}

async function invokeNfts(deps: WalletRouteDependencies): Promise<void> {
  await handleWalletRoutes(walletRouteCtx("/api/wallet/nfts", deps));
}

describe("wallet routes observability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    createSpanMock.mockReturnValue({
      success: spanSuccessMock,
      failure: spanFailureMock,
    });
    delete process.env.ELIZAOS_CLOUD_API_KEY;
    delete process.env.SOLANA_RPC_URL;
    process.env.ALCHEMY_API_KEY = "alchemy";
    process.env.HELIUS_API_KEY = "helius";
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const value = ORIGINAL_ENV[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    vi.restoreAllMocks();
  });

  it("records success spans for wallet balance fetches", async () => {
    const deps = baseDeps();

    await invokeBalances(deps);

    expect(createSpanMock).toHaveBeenCalledWith({
      boundary: "wallet",
      operation: "fetch_evm_balances",
    });
    expect(createSpanMock).toHaveBeenCalledWith({
      boundary: "wallet",
      operation: "fetch_solana_balances",
    });
    expect(spanSuccessMock).toHaveBeenCalledTimes(2);
    expect(spanFailureMock).not.toHaveBeenCalled();
  });

  it("records failure spans when wallet providers fail", async () => {
    const deps = baseDeps();
    deps.fetchEvmBalances = vi.fn(async () => {
      throw new Error("provider down");
    });
    delete process.env.HELIUS_API_KEY;

    await invokeBalances(deps);

    expect(createSpanMock).toHaveBeenCalledWith({
      boundary: "wallet",
      operation: "fetch_evm_balances",
    });
    expect(spanFailureMock).toHaveBeenCalledTimes(1);
    expect(spanFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });

  it("records success spans for wallet NFT fetches", async () => {
    const deps = baseDeps();

    await invokeNfts(deps);

    expect(createSpanMock).toHaveBeenCalledWith({
      boundary: "wallet",
      operation: "fetch_evm_nfts",
    });
    expect(createSpanMock).toHaveBeenCalledWith({
      boundary: "wallet",
      operation: "fetch_solana_nfts",
    });
    expect(spanSuccessMock).toHaveBeenCalledTimes(2);
    expect(spanFailureMock).not.toHaveBeenCalled();
  });

  it("records failure span when NFT provider throws", async () => {
    const deps = baseDeps();
    deps.fetchEvmNfts = vi.fn(async () => {
      throw new Error("nft api down");
    });
    delete process.env.HELIUS_API_KEY;

    await invokeNfts(deps);

    expect(createSpanMock).toHaveBeenCalledWith({
      boundary: "wallet",
      operation: "fetch_evm_nfts",
    });
    expect(spanFailureMock).toHaveBeenCalledTimes(1);
    expect(spanFailureMock).toHaveBeenCalledWith(
      expect.objectContaining({ error: expect.any(Error) }),
    );
  });
});
