/**
 * EVM service cache reads use stale-while-revalidate without blocking on RPC.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { CACHE_REFRESH_INTERVAL_MS, EVM_WALLET_DATA_CACHE_KEY } from "../../constants";
import { EVMService, type EVMWalletData } from "../../service";

function runtimeWithCache(value: EVMWalletData | undefined): IAgentRuntime {
  return {
    getCache: vi.fn(async (key: string) => (key === EVM_WALLET_DATA_CACHE_KEY ? value : undefined)),
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
}

describe("EVMService cache reads", () => {
  it("returns stale data while a background refresh remains pending", async () => {
    const stale: EVMWalletData = {
      address: "0x1234",
      chains: [],
      timestamp: Date.now() - CACHE_REFRESH_INTERVAL_MS - 1,
    };
    const runtime = runtimeWithCache(stale);
    const service = new EVMService(runtime);
    let finishRefresh: (() => void) | undefined;
    const refresh = vi.spyOn(service, "refreshWalletData").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishRefresh = resolve;
        })
    );

    await expect(service.getCachedData()).resolves.toBe(stale);
    expect(refresh).toHaveBeenCalledOnce();
    finishRefresh?.();
  });

  it("returns missing state immediately and starts background refresh", async () => {
    const runtime = runtimeWithCache(undefined);
    const service = new EVMService(runtime);
    const refresh = vi.spyOn(service, "refreshWalletData").mockResolvedValue();

    await expect(service.getCachedData()).resolves.toBeUndefined();
    expect(refresh).toHaveBeenCalledOnce();
  });
});
