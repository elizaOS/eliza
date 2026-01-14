import {
  logger,
  type IAgentRuntime,
  type Memory,
  type Provider,
  type State,
} from "@elizaos/core";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  Clmm,
  type ClmmPoolInfo,
  Position,
} from "@raydium-io/raydium-sdk";

export interface FetchedPositionStatistics {
  poolAddress: PublicKey;
  positionNftMint: PublicKey;
  inRange: boolean;
  distanceCenterPositionFromPoolPriceBps: number;
  positionWidthBps: number;
}

export const raydiumPositionProvider: Provider = {
  name: "raydium-lp-position-provider",
  get: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    if (!state) {
      state = (await runtime.composeState(message)) as State;
    } else {
      state = await runtime.updateRecentMessageState(state);
    }
    try {
      const privateKey = runtime.getSetting('SOLANA_PRIVATE_KEY');
      if (!privateKey || typeof privateKey !== 'string') {
        logger.warn("SOLANA_PRIVATE_KEY not configured");
        return null;
      }
      
      // Decode the private key to get public address
      const bs58 = await import('bs58');
      const { Keypair } = await import('@solana/web3.js');
      const secretKey = bs58.default.decode(privateKey);
      const keypair = Keypair.fromSecretKey(secretKey);
      const ownerAddress = keypair.publicKey;
      
      const rpcUrl = runtime.getSetting('SOLANA_RPC_URL') || 'https://api.mainnet-beta.solana.com';
      const connection = new Connection(rpcUrl as string);
      const positions = await fetchPositions(connection, ownerAddress);
      return JSON.stringify(positions);
    } catch (error) {
      logger.error("Error in Raydium position provider:", error);
      return null;
    }
  },
};

const fetchPositions = async (
  connection: Connection,
  ownerAddress: PublicKey
): Promise<FetchedPositionStatistics[]> => {
  try {
    // Get all positions for the owner
    const positions = await Position.getPositionsByOwner(
      connection,
      ownerAddress
    );

    // Fetch all unique pools
    const poolsMap = new Map<string, ClmmPoolInfo>();

    // First pass: collect all pool addresses
    for (const position of positions) {
      if (!poolsMap.has(position.poolId.toString())) {
        const poolInfo = await Clmm.getPool(connection, position.poolId);
        poolsMap.set(position.poolId.toString(), poolInfo);
      }
    }

    const fetchedPositionsStatistics: FetchedPositionStatistics[] =
      await Promise.all(
        positions.map(async (position) => {
          const pool = poolsMap.get(position.poolId.toString())!;

          // Calculate price and range information
          const currentPrice = pool.currentPrice;
          const positionLowerPrice = pool.tickArrayLower;
          const positionUpperPrice = pool.tickArrayUpper;

          // Check if position is in range
          const inRange =
            position.tickLower <= pool.currentTickIndex &&
            pool.currentTickIndex <= position.tickUpper;

          // Calculate position metrics
          const positionCenterPrice =
            (positionLowerPrice + positionUpperPrice) / 2;
          const distanceCenterPositionFromPoolPriceBps =
            (Math.abs(currentPrice - positionCenterPrice) / currentPrice) *
            10000;
          const positionWidthBps =
            (((positionUpperPrice - positionLowerPrice) / positionCenterPrice) *
              10000) /
            2;

          return {
            poolAddress: position.poolId,
            positionNftMint: position.nftMint,
            inRange,
            distanceCenterPositionFromPoolPriceBps,
            positionWidthBps,
          } as FetchedPositionStatistics;
        })
      );

    return fetchedPositionsStatistics;
  } catch (error) {
    logger.error("Error during fetching Raydium positions:", error);
    throw new Error("Error during fetching positions");
  }
};
