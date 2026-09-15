/**
 * EVM service cache reads use stale-while-revalidate without blocking on RPC.
 */
import { AgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { CACHE_REFRESH_INTERVAL_MS, EVM_WALLET_DATA_CACHE_KEY } from "../../constants";
import { EVMService, type EVMWalletData } from "../../service";

const initWalletProviderMock = vi.hoisted(() => vi.fn());
vi.mock("../../providers/wallet", () => ({
  initWalletProvider: initWalletProviderMock,
}));

describe("EVMService cache reads", () => {
  it("returns stale data while a background refresh remains pending", async () => {
    const stale: EVMWalletData = {
      address: "0x1234",
      chains: [],
      timestamp: Date.now() - CACHE_REFRESH_INTERVAL_MS - 1,
    };
    const runtime = new AgentRuntime({ logLevel: "fatal" });
    vi.spyOn(runtime, "getCache").mockResolvedValue(stale);
    const service = new EVMService(runtime);
    let finishRefresh: (() => void) | undefined;
    const refresh = vi.spyOn(service, "refreshWalletData").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        })
    );

    await expect(service.getCachedData()).resolves.toStrictEqual(stale);
    expect(refresh).toHaveBeenCalledOnce();
    finishRefresh?.();
  });

  it("returns missing state immediately and starts background refresh", async () => {
    const runtime = new AgentRuntime({ logLevel: "fatal" });
    vi.spyOn(runtime, "getCache").mockResolvedValue(undefined);
    const service = new EVMService(runtime);
    const refresh = vi.spyOn(service, "refreshWalletData").mockResolvedValue();

    await expect(service.getCachedData()).resolves.toBeUndefined();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent refreshes and writes one forced network snapshot", async () => {
    const runtime = new AgentRuntime({ logLevel: "fatal" });
    const setCache = vi.spyOn(runtime, "setCache").mockResolvedValue(true);
    type States = Record<string, { status: "ok"; balance: string }>;
    let releaseBalances: ((balances: States) => void) | undefined;
    const getChainBalanceStates = vi.fn(
      () =>
        new Promise<States>((resolve) => {
          releaseBalances = resolve;
        })
    );
    const wallet = {
      getAddress: vi.fn(() => "0x1234"),
      getChainBalanceStates,
      getChainConfigs: vi.fn(() => ({
        id: 1,
        name: "Ethereum",
        nativeCurrency: { symbol: "ETH" },
      })),
    };
    initWalletProviderMock.mockResolvedValue(wallet);
    const service = new EVMService(runtime);

    const first = service.refreshWalletData();
    const second = service.refreshWalletData();
    await Promise.resolve();
    expect(initWalletProviderMock).toHaveBeenCalledOnce();
    expect(getChainBalanceStates).toHaveBeenCalledOnce();
    expect(getChainBalanceStates).toHaveBeenCalledWith(true);

    releaseBalances?.({ mainnet: { status: "ok", balance: "1.5" } });
    await Promise.all([first, second]);

    expect(setCache).toHaveBeenCalledOnce();
    expect(setCache).toHaveBeenCalledWith(
      EVM_WALLET_DATA_CACHE_KEY,
      expect.objectContaining({
        address: "0x1234",
        chains: [
          {
            chainName: "mainnet",
            balance: "1.5",
            symbol: "ETH",
            chainId: 1,
            name: "Ethereum",
          },
        ],
        unavailableChains: [],
      })
    );
    expect(service.getWalletProvider()).toBe(wallet);
  });

  it("records an unreachable chain as unavailable instead of dropping it (#31111)", async () => {
    const runtime = new AgentRuntime({ logLevel: "fatal" });
    const setCache = vi.spyOn(runtime, "setCache").mockResolvedValue(true);
    const wallet = {
      getAddress: vi.fn(() => "0x1234"),
      getChainBalanceStates: vi.fn(async () => ({
        mainnet: { status: "ok", balance: "1.5" },
        optimism: { status: "unavailable", error: "HTTP request failed: 503" },
      })),
      getChainConfigs: vi.fn(() => ({
        id: 1,
        name: "Ethereum",
        nativeCurrency: { symbol: "ETH" },
      })),
    };
    initWalletProviderMock.mockResolvedValue(wallet);
    const service = new EVMService(runtime);

    await service.refreshWalletData();

    expect(setCache).toHaveBeenCalledWith(
      EVM_WALLET_DATA_CACHE_KEY,
      expect.objectContaining({
        chains: [expect.objectContaining({ chainName: "mainnet", balance: "1.5" })],
        unavailableChains: [{ chainName: "optimism", error: "HTTP request failed: 503" }],
      })
    );
  });

  it("throws an explicit uninitialized error before the first refresh", () => {
    const runtime = new AgentRuntime({ logLevel: "fatal" });
    const service = new EVMService(runtime);

    expect(() => service.getWalletProvider()).toThrow("Wallet provider not initialized");
  });
});
