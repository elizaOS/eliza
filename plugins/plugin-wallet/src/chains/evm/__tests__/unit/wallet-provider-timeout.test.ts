/**
 * Wallet balance formatting and transport-failure behavior at the RPC boundary.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { generatePrivateKey } from "viem/accounts";
import { mainnet } from "viem/chains";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WalletProvider } from "../../providers/wallet";

function makeRuntime(): IAgentRuntime {
  return {
    getCache: vi.fn(async () => null),
    setCache: vi.fn(async () => undefined),
    getSetting: vi.fn(() => undefined),
  } as unknown as IAgentRuntime;
}

describe("WalletProvider RPC balance reads", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns null when the cancellation-aware transport rejects", async () => {
    const provider = new WalletProvider(generatePrivateKey(), makeRuntime(), {
      mainnet,
    });

    vi.spyOn(provider, "getPublicClient").mockReturnValue({
      getBalance: async () => {
        throw new DOMException("The operation timed out", "TimeoutError");
      },
    } as never);

    await expect(provider.getWalletBalanceForChain("mainnet" as never)).resolves.toBeNull();
  });

  it("returns the formatted balance when the RPC responds in time", async () => {
    const provider = new WalletProvider(generatePrivateKey(), makeRuntime(), {
      mainnet,
    });

    vi.spyOn(provider, "getPublicClient").mockReturnValue({
      getBalance: async () => 1_000000000000000000n, // 1.0 ETH in wei
    } as never);

    await expect(provider.getWalletBalanceForChain("mainnet" as never)).resolves.toBe("1");
  });
});
