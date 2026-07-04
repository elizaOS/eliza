/**
 * Regression guard for a per-reply hang: `evmWalletProvider.get()` runs inside
 * `composeState` on every message and is awaited before the agent replies, so
 * a balance RPC against a slow/unreachable endpoint must bound itself rather
 * than block the turn until `composeState`'s provider timeout fires.
 * `getWalletBalanceForChain` is expected to resolve to `null` (same as any RPC
 * error) instead of hanging. Uses fake timers and a mocked public client — no
 * real RPC calls.
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

describe("WalletProvider per-turn RPC timeout", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("resolves to null instead of hanging when the balance RPC never responds", async () => {
    vi.useFakeTimers();
    const provider = new WalletProvider(generatePrivateKey(), makeRuntime(), {
      mainnet,
    });

    // Simulate a mainnet RPC that accepts the request but never responds.
    vi.spyOn(provider, "getPublicClient").mockReturnValue({
      getBalance: () => new Promise<bigint>(() => undefined),
    } as never);

    const resultPromise = provider.getWalletBalanceForChain("mainnet" as never);
    // Advance past the per-call bound; the race rejects and the catch returns null.
    await vi.advanceTimersByTimeAsync(3500);

    await expect(resultPromise).resolves.toBeNull();
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
