// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import {
  type IAgentRuntime,
  logger,
  type Memory,
  type Provider,
  type State,
  validateActionKeywords,
  validateActionRegex,
} from "@elizaos/core";
import { Clmm, type ClmmPoolInfo, Position } from "@raydium-io/raydium-sdk";
import { Connection, type PublicKey } from "@solana/web3.js";

export interface FetchedPositionStatistics {
  poolAddress: PublicKey;
  positionNftMint: PublicKey;
  inRange: boolean;
  distanceCenterPositionFromPoolPriceBps: number;
  positionWidthBps: number;
}

export const raydiumPositionProvider: Provider = {
  name: "raydium-lp-position-provider",
  description: "Provides Raydium LP position status.",
  descriptionCompressed: "Raydium LP positions status.",
  dynamic: true,
  relevanceKeywords: [
    "raydium",
    "position",
    "raydiumpositionprovider",
    "plugin",
    "manager",
    "status",
    "state",
    "context",
    "info",
    "details",
    "chat",
    "conversation",
    "agent",
    "room",
  ],
  get: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    const __providerKeywords = [
      "raydium",
      "position",
      "raydiumpositionprovider",
      "plugin",
      "manager",
      "status",
      "state",
      "context",
      "info",
      "details",
      "chat",
      "conversation",
      "agent",
      "room",
    ];
    const __providerRegex = new RegExp(`\\b(${__providerKeywords.join("|")})\\b`, "i");
    const __recentMessages = state?.recentMessagesData || [];
    const __isRelevant =
      validateActionKeywords(message, __recentMessages, __providerKeywords) ||
      validateActionRegex(message, __recentMessages, __providerRegex);
    if (!__isRelevant) {
      return { text: "" };
    }

    if (!state) {
      state = (await runtime.composeState(message)) as State;
    } else {
      state = await runtime.updateRecentMessageState(state);
    }
    try {
      const privateKey = runtime.getSetting("SOLANA_PRIVATE_KEY");
      if (!privateKey || typeof privateKey !== "string") {
        logger.warn("SOLANA_PRIVATE_KEY not configured");
        return null;
      }

      // Decode the private key to get public address
      const bs58 = await import("bs58");
      const { Keypair } = await import("@solana/web3.js");
      const secretKey = bs58.default.decode(privateKey);
      const keypair = Keypair.fromSecretKey(secretKey);
      const ownerAddress = keypair.publicKey;

      const rpcUrl = runtime.getSetting("SOLANA_RPC_URL") || "https://api.mainnet-beta.solana.com";
      const connection = new Connection(rpcUrl as string);
      const positions = await fetchPositions(connection, ownerAddress);
      return {
        text: formatPositionsForPrompt(positions),
        data: { positions },
      };
    } catch (error) {
      logger.error("Error in Raydium position provider:", error);
      return null;
    }
  },
};

function formatPositionsForPrompt(positions: FetchedPositionStatistics[]): string {
  if (positions.length === 0) {
    return "Raydium LP positions:\npositions:";
  }
  const lines = ["Raydium LP positions:"];
  positions.forEach((position, index) => {
    lines.push(
      `positions[${index}]{poolAddress,positionNftMint,inRange,distanceCenterPositionFromPoolPriceBps,positionWidthBps}: ${position.poolAddress.toString()},${position.positionNftMint.toString()},${position.inRange},${position.distanceCenterPositionFromPoolPriceBps},${position.positionWidthBps}`
    );
  });
  return lines.join("\n");
}

const fetchPositions = async (
  connection: Connection,
  ownerAddress: PublicKey
): Promise<FetchedPositionStatistics[]> => {
  try {
    // Get all positions for the owner
    const positions = await Position.getPositionsByOwner(connection, ownerAddress);

    // Fetch all unique pools
    const poolsMap = new Map<string, ClmmPoolInfo>();

    // First pass: collect all pool addresses
    for (const position of positions) {
      if (!poolsMap.has(position.poolId.toString())) {
        const poolInfo = await Clmm.getPool(connection, position.poolId);
        poolsMap.set(position.poolId.toString(), poolInfo);
      }
    }

    const fetchedPositionsStatistics: FetchedPositionStatistics[] = await Promise.all(
      positions.map(async (position) => {
        const pool = poolsMap.get(position.poolId.toString());
        if (!pool) {
          throw new Error(`Missing pool metadata for pool ID ${position.poolId.toString()}`);
        }

        // Calculate price and range information
        const currentPrice = pool.currentPrice;
        const positionLowerPrice = pool.tickArrayLower;
        const positionUpperPrice = pool.tickArrayUpper;

        // Check if position is in range
        const inRange =
          position.tickLower <= pool.currentTickIndex &&
          pool.currentTickIndex <= position.tickUpper;

        // Calculate position metrics
        const positionCenterPrice = (positionLowerPrice + positionUpperPrice) / 2;
        const distanceCenterPositionFromPoolPriceBps =
          (Math.abs(currentPrice - positionCenterPrice) / currentPrice) * 10000;
        const positionWidthBps =
          (((positionUpperPrice - positionLowerPrice) / positionCenterPrice) * 10000) / 2;

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
