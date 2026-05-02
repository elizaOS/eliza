import {
  elizaLogger,
  IAgentRuntime,
  Memory,
  Provider,
  ProviderResult,
  State,
} from "@elizaos/core";
import { Connection, PublicKey } from "@solana/web3.js";

export interface FetchedPositionStatistics {
  poolAddress: PublicKey;
  positionNftMint: PublicKey;
  inRange: boolean;
  distanceCenterPositionFromPoolPriceBps: number;
  positionWidthBps: number;
}

// TODO: The 'loadWallet' function is not defined in the current workspace.
// This is likely due to an incomplete workspace setup. This declaration
// is a temporary workaround.
declare function loadWallet(
  runtime: IAgentRuntime,
  a: boolean,
): Promise<{ address: PublicKey }>;

export const positionProvider: Provider = {
  name: "raydium-lp-position-provider",
  get: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
  ): Promise<ProviderResult> => {
    if (!state) {
      state = (await runtime.composeState(message)) as State;
    } else {
      // TODO: `updateRecentMessageState` is not a method on `IAgentRuntime`.
      // This needs to be investigated and fixed.
      // state = await runtime.updateRecentMessageState(state);
    }
    try {
      const { address: ownerAddress } = await loadWallet(runtime, false);
      const rpcUrl = runtime.getSetting("SOLANA_RPC_URL");
      if (!rpcUrl) {
        throw new Error("SOLANA_RPC_URL is not set in the agent's settings.");
      }
      const connection = new Connection(rpcUrl);
      const positions = await fetchPositions(connection, ownerAddress);
      return positions;
    } catch (error) {
      elizaLogger.error("Error in position provider:", error);
      return [];
    }
  },
};

const fetchPositions = async (
  connection: Connection,
  ownerAddress: PublicKey,
): Promise<FetchedPositionStatistics[]> => {
  try {
    // TODO: The following code is commented out because it depends on the
    // 'Position' and 'Clmm' objects from the @raydium-io/raydium-sdk,
    // which are currently unavailable due to import issues. This code
    // should be re-enabled when the dependencies are fixed.

    // const positions = await Position.getPositionsByOwner(
    //   connection,
    //   ownerAddress
    // );

    // const poolsMap = new Map<string, ClmmPoolInfo>();

    // for (const position of positions) {
    //   if (!poolsMap.has(position.poolId.toString())) {
    //     const poolInfo = await Clmm.getPool(connection, position.poolId);
    //     poolsMap.set(position.poolId.toString(), poolInfo);
    //   }
    // }

    // const fetchedPositionsStatistics: FetchedPositionStatistics[] =
    //   await Promise.all(
    //     positions.map(async (position) => {
    //       const pool = poolsMap.get(position.poolId.toString())!;

    //       const currentPrice = pool.currentPrice;
    //       const positionLowerPrice = pool.tickArrayLower;
    //       const positionUpperPrice = pool.tickArrayUpper;

    //       const inRange =
    //         position.tickLower <= pool.currentTickIndex &&
    //         pool.currentTickIndex <= position.tickUpper;

    //       const positionCenterPrice =
    //         (positionLowerPrice + positionUpperPrice) / 2;
    //       const distanceCenterPositionFromPoolPriceBps =
    //         (Math.abs(currentPrice - positionCenterPrice) / currentPrice) *
    //         10000;
    //       const positionWidthBps =
    //         (((positionUpperPrice - positionLowerPrice) / positionCenterPrice) *
    //           10000) /
    //         2;

    //       return {
    //         poolAddress: position.poolId,
    //         positionNftMint: position.nftMint,
    //         inRange,
    //         distanceCenterPositionFromPoolPriceBps,
    //         positionWidthBps,
    //       } as FetchedPositionStatistics;
    //     })
    //   );

    // return fetchedPositionsStatistics;

    return []; // Return empty array as a temporary workaround
  } catch (error) {
    elizaLogger.error("Error during fetching positions:", error);
    throw new Error("Error during fetching positions");
  }
};
