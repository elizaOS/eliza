/**
 * Closing an LP position must not accept any output. The close quotes what
 * the position returns now and requires that amount minus the confirmed
 * slippage, so a sandwich around the close reverts instead of taking the
 * position's value. Real UniswapV3LpService and AerodromeLpService
 * removeLiquidity; only the chain clients are stubbed.
 */
import { describe, expect, it, vi } from "vitest";
import { AerodromeLpService } from "../aerodrome/services/AerodromeLpService";
import { PancakeSwapV3LpService } from "../pancakeswp/services/PancakeSwapV3LpService";
import { UniswapV3LpService } from "../uniswap/services/UniswapV3LpService";

const WALLET = {
  address: "0x1111111111111111111111111111111111111111" as const,
  privateKey: `0x${"11".repeat(32)}` as const,
};

function chainClients(quoted: readonly [bigint, bigint]) {
  const simulated: Array<{ functionName: string; args: readonly unknown[] }> = [];
  const publicClient = {
    simulateContract: vi.fn(async (call: { functionName: string; args: readonly unknown[] }) => {
      simulated.push(call);
      return { result: quoted, request: call };
    }),
    waitForTransactionReceipt: vi.fn(async () => ({
      status: "success",
      blockNumber: 1n,
      gasUsed: 1n,
    })),
    readContract: vi.fn(async () => 1_000n),
  };
  const walletClient = {
    account: { address: WALLET.address },
    writeContract: vi.fn(async () => "0xhash"),
  };
  return { publicClient, walletClient, simulated };
}

describe("LP close minimums", () => {
  it("Uniswap V3 decreaseLiquidity requires the quoted amounts minus slippage", async () => {
    const { publicClient, walletClient, simulated } = chainClients([10_000n, 20_000n]);
    const service = new UniswapV3LpService();
    Object.assign(service as object, {
      getPublicClient: () => publicClient,
      getWalletClient: () => walletClient,
      getPositionFromContract: async () => ({ liquidity: 5_000n }),
    });

    const result = await service.removeLiquidity({
      chainId: 1,
      tokenId: 7n,
      percentageToRemove: 50,
      slippageBps: 100,
      wallet: WALLET,
    } as never);

    expect(result.success).toBe(true);
    const decreases = simulated.filter((call) => call.functionName === "decreaseLiquidity");
    const sent = decreases.at(-1)?.args[0] as { amount0Min: bigint; amount1Min: bigint };
    expect(sent).toMatchObject({ amount0Min: 9_900n, amount1Min: 19_800n, liquidity: 2_500n });
  });

  it("PancakeSwap V3 decreaseLiquidity requires the quoted amounts minus slippage", async () => {
    const { publicClient, walletClient, simulated } = chainClients([1_000n, 0n]);
    const service = new PancakeSwapV3LpService();
    Object.assign(service as object, {
      getPublicClient: () => publicClient,
      getWalletClient: () => walletClient,
      getPositionFromContract: async () => ({ liquidity: 800n }),
    });

    const result = await service.removeLiquidity({
      chainId: 56,
      tokenId: 9n,
      percentageToRemove: 100,
      slippageBps: 50,
      wallet: WALLET,
    } as never);

    expect(result.success).toBe(true);
    const decreases = simulated.filter((call) => call.functionName === "decreaseLiquidity");
    const sent = decreases.at(-1)?.args[0] as { amount0Min: bigint; amount1Min: bigint };
    expect(sent).toMatchObject({ amount0Min: 995n, amount1Min: 0n });
  });

  it.each([
    ["Uniswap V3", () => new UniswapV3LpService(), 1],
    ["PancakeSwap V3", () => new PancakeSwapV3LpService(), 56],
  ] as const)("%s reports a reverted decreaseLiquidity as a failed close", async (_name, makeService, chainId) => {
    const { publicClient, walletClient, simulated } = chainClients([1_000n, 2_000n]);
    publicClient.waitForTransactionReceipt.mockResolvedValueOnce({
      status: "reverted",
      blockNumber: 2n,
      gasUsed: 3n,
    });
    walletClient.writeContract.mockResolvedValueOnce("0xdecrease");
    const service = makeService();
    Object.assign(service as object, {
      getPublicClient: () => publicClient,
      getWalletClient: () => walletClient,
      getPositionFromContract: async () => ({ liquidity: 800n }),
    });

    const result = await service.removeLiquidity({
      chainId,
      tokenId: 9n,
      percentageToRemove: 100,
      slippageBps: 50,
      wallet: WALLET,
    } as never);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/decreaseLiquidity reverted/);
    expect(result).toMatchObject({ hash: "0xdecrease" });
    expect(walletClient.writeContract).toHaveBeenCalledTimes(1);
    const later = simulated.filter(
      (call) => call.functionName === "collect" || call.functionName === "burn"
    );
    expect(later).toEqual([]);
  });

  it("Aerodrome removeLiquidity requires the quoted amounts minus slippage", async () => {
    const { publicClient, walletClient, simulated } = chainClients([3_000n, 4_000n]);
    const service = new AerodromeLpService();
    Object.assign(service as object, {
      getPublicClient: () => publicClient,
      getWalletClient: () => walletClient,
      approveToken: async () => undefined,
      getPoolInfo: async () => ({
        tokenA: { address: "0x2222222222222222222222222222222222222222" },
        tokenB: { address: "0x3333333333333333333333333333333333333333" },
        metadata: { stable: false },
      }),
    });

    const result = await service.removeLiquidity({
      chainId: 8453,
      poolAddress: "0x4444444444444444444444444444444444444444",
      percentageToRemove: 100,
      slippageBps: 50,
      wallet: WALLET,
    } as never);

    expect(result.success).toBe(true);
    const removes = simulated.filter((call) => call.functionName === "removeLiquidity");
    expect(removes.at(-1)?.args.slice(4, 6)).toEqual([2_985n, 3_980n]);
  });
});
