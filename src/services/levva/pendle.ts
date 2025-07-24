import { PoolConstants } from "./pool";
import pendleAdapterAbi from "./abi/pendle.adapter.abi";
import type { PendleActiveMarkets } from "../../api/market/pendle";
import { getChain, getClient } from "../../util/eth";

const ADAPTERS = new Map<number, `0x${string}`>([
  [42161, "0x03fA449776FBE2a38771BD638be94E32592372f6"],
]);

const NULL_ADDRESS = "0x0000000000000000000000000000000000000000";

export const getPendleParams = async (
  chainId: number,
  params: Pick<PoolConstants, "baseToken" | "quoteToken">
): Promise<
  | {
      market: `0x${string}`;
      slippage: number;
    }
  | undefined
> => {
  const adapter = ADAPTERS.get(chainId);

  if (!adapter) {
    throw new Error(`Adapter not found for chainId ${chainId}`);
  }

  const chain = getChain(chainId);
  const client = getClient(chain);

  const [market, slippage] = await client.readContract({
    abi: pendleAdapterAbi,
    address: adapter,
    functionName: "getPoolData",
    args: [params.baseToken, params.quoteToken],
  });

  if (market === NULL_ADDRESS) {
    return;
  }

  return {
    market,
    slippage,
  };
};

export interface PendleInterface {
  getPendleMarkets(params: { chainId: number }): Promise<PendleActiveMarkets>;
  getPendleParams: typeof getPendleParams;
}
