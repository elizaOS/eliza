/**
 * A V3 position holds the tokens that its liquidity is worth at the pool's
 * current price. `tokensOwed` is only the amount that is not collected yet,
 * so a live position was reported as holding 0 of each token. Real
 * UniswapV3LpService and PancakeSwapV3LpService getPositionDetails; only the
 * chain client is stubbed. The expected amounts are the amounts that
 * @uniswap/v3-sdk computes for the same position.
 */
import type { Address } from "viem";
import { describe, expect, it, vi } from "vitest";
import { PancakeSwapV3LpService } from "../pancakeswp/services/PancakeSwapV3LpService";
import { UniswapV3LpService } from "../uniswap/services/UniswapV3LpService";

const OWNER = "0x1111111111111111111111111111111111111111" as Address;
const POOL = "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640" as Address;
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as Address;
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as Address;

// A USDC/WETH 0.05% position between ticks 195000 and 200000.
const POSITION = {
  tokenId: 7n,
  token0: USDC,
  token1: WETH,
  fee: 500,
  tickLower: 195_000,
  tickUpper: 200_000,
  liquidity: 2_000_000_000_000_000n,
  tokensOwed0: 1_500_000n,
  tokensOwed1: 400_000_000_000_000n,
};

function serviceAt<T extends object>(service: T, tick: number, sqrtPriceX96: bigint): T {
  const client = {
    readContract: vi.fn(async (call: { address: Address; functionName: string }) => {
      if (call.functionName === "slot0") return [sqrtPriceX96, tick, 0, 1, 1, 0, true];
      if (call.functionName === "symbol") return call.address === USDC ? "USDC" : "WETH";
      if (call.functionName === "decimals") return call.address === USDC ? 6 : 18;
      throw new Error(`unexpected read ${call.functionName}`);
    }),
  };
  return Object.assign(service, {
    getPublicClient: () => client,
    getPositionFromContract: async () => POSITION,
  });
}

describe("V3 LP position amounts", () => {
  it.each([
    ["Uniswap V3", () => new UniswapV3LpService(), 1],
    ["PancakeSwap V3", () => new PancakeSwapV3LpService(), 56],
  ] as const)("%s reports what an in-range position holds", async (_name, makeService, chainId) => {
    const service = serviceAt(makeService(), 197_500, 1539299661710459767826542992206865n);

    const details = await service.getPositionDetails(chainId, OWNER, POOL, POSITION.tokenId);

    expect(details?.underlyingTokens.map((token) => [token.symbol, token.balance])).toEqual([
      ["USDC", "12095263535"],
      ["WETH", "4565648949347867071"],
    ]);
    expect(details?.accruedFees.map((token) => [token.symbol, token.balance])).toEqual([
      ["USDC", "1500000"],
      ["WETH", "400000000000000"],
    ]);
  });

  it.each([
    ["below", 194_000, 1292187213925453985058262482146976n, ["25800907045", "0"]],
    ["above", 201_000, 1833668854642163783923789245351438n, ["0", "9739174661066327156"]],
  ] as const)(
    "reports one token when the price is %s the range",
    async (_side, tick, sqrtPriceX96, expected) => {
      const service = serviceAt(new UniswapV3LpService(), tick, sqrtPriceX96);

      const details = await service.getPositionDetails(1, OWNER, POOL, POSITION.tokenId);

      expect(details?.underlyingTokens.map((token) => token.balance)).toEqual(expected);
    }
  );
});
