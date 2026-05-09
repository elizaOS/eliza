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
import { buildWhirlpoolClient, PoolUtil } from "@orca-so/whirlpools-sdk";
import { getMint } from "@solana/spl-token";
import { Connection, type PublicKey } from "@solana/web3.js";
import { loadWallet } from "../utils/loadWallet.ts";

const POSITION_LIMIT = 20;

export interface FetchedPositionStatistics {
  whirlpoolAddress: PublicKey;
  positionMint: PublicKey;
  inRange: boolean;
  distanceCenterPositionFromPoolPriceBps: number;
  positionWidthBps: number;
}

export const positionProvider: Provider = {
  name: "orca-lp-position-provider",
  description: "Provides Orca LP position status.",
  descriptionCompressed: "Orca LP positions status.",
  dynamic: true,
  contexts: ["finance", "crypto", "wallet"],
  contextGate: { anyOf: ["finance", "crypto", "wallet"] },
  cacheStable: false,
  cacheScope: "turn",
  roleGate: { minRole: "OWNER" },
  relevanceKeywords: [
    "orca",
    "position",
    "positionprovider",
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
      "orca",
      "position",
      "positionprovider",
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
      const { address: ownerAddress } = await loadWallet(runtime, false);
      const rpcUrl = runtime.getSetting("SOLANA_RPC_URL") || "https://api.mainnet-beta.solana.com";
      const connection = new Connection(rpcUrl as string);
      const positions = await fetchPositions(connection, ownerAddress);
      return {
        text: formatPositionsForPrompt(positions.slice(0, POSITION_LIMIT)),
        data: { positions: positions.slice(0, POSITION_LIMIT) },
      };
    } catch (error) {
      logger.error("Error in Orca position provider:", error);
      return {
        text: "Orca LP positions unavailable.",
        data: {
          positions: [],
          error: error instanceof Error ? error.message : String(error),
        },
        values: { positionCount: 0, hasPositions: false },
      };
    }
  },
};

function formatPositionsForPrompt(positions: FetchedPositionStatistics[]): string {
  if (positions.length === 0) {
    return "Orca LP positions:\npositions:";
  }
  const lines = ["Orca LP positions:"];
  positions.forEach((position, index) => {
    lines.push(
      `positions[${index}]{whirlpoolAddress,positionMint,inRange,distanceCenterPositionFromPoolPriceBps,positionWidthBps}: ${position.whirlpoolAddress.toString()},${position.positionMint.toString()},${position.inRange},${position.distanceCenterPositionFromPoolPriceBps},${position.positionWidthBps}`
    );
  });
  return lines.join("\n");
}

const fetchPositions = async (
  connection: Connection,
  ownerAddress: PublicKey
): Promise<FetchedPositionStatistics[]> => {
  try {
    const client = buildWhirlpoolClient(connection);
    const positions = await client.getUserPositions(ownerAddress);
    const fetchedWhirlpools = new Map();
    const fetchedMints = new Map();
    const FetchedPositionsStatistics: FetchedPositionStatistics[] = await Promise.all(
      positions.map(async (position) => {
        const positionData = position.getData();
        const positionMint = position.getAddress();
        const whirlpoolAddress = position.getWhirlpoolAddress();

        if (!fetchedWhirlpools.has(whirlpoolAddress.toString())) {
          const whirlpool = await client.getWhirlpool(whirlpoolAddress);
          if (whirlpool) {
            fetchedWhirlpools.set(whirlpoolAddress.toString(), whirlpool);
          }
        }
        const whirlpool = fetchedWhirlpools.get(whirlpoolAddress.toString());
        const tokenMintA = whirlpool.getTokenAMint();
        const tokenMintB = whirlpool.getTokenBMint();

        if (!fetchedMints.has(tokenMintA.toString())) {
          const mintA = await getMint(connection, tokenMintA);
          fetchedMints.set(tokenMintA.toString(), mintA);
        }
        if (!fetchedMints.has(tokenMintB.toString())) {
          const mintB = await getMint(connection, tokenMintB);
          fetchedMints.set(tokenMintB.toString(), mintB);
        }
        const mintA = fetchedMints.get(tokenMintA.toString());
        const mintB = fetchedMints.get(tokenMintB.toString());

        const currentPrice = PoolUtil.sqrtPriceX64ToPrice(
          whirlpool.getData().sqrtPrice,
          mintA.decimals,
          mintB.decimals
        );
        const positionLowerPrice = PoolUtil.tickIndexToPrice(
          positionData.tickLowerIndex,
          mintA.decimals,
          mintB.decimals
        );
        const positionUpperPrice = PoolUtil.tickIndexToPrice(
          positionData.tickUpperIndex,
          mintA.decimals,
          mintB.decimals
        );

        const currentTick = whirlpool.getData().tickCurrentIndex;
        const inRange =
          currentTick >= positionData.tickLowerIndex && currentTick <= positionData.tickUpperIndex;
        const positionCenterPrice = (positionLowerPrice + positionUpperPrice) / 2;
        const distanceCenterPositionFromPoolPriceBps =
          (Math.abs(currentPrice - positionCenterPrice) / currentPrice) * 10000;
        const positionWidthBps =
          (((positionUpperPrice - positionLowerPrice) / positionCenterPrice) * 10000) / 2;

        return {
          whirlpoolAddress,
          positionMint,
          inRange,
          distanceCenterPositionFromPoolPriceBps,
          positionWidthBps,
        } as FetchedPositionStatistics;
      })
    );

    return FetchedPositionsStatistics;
  } catch (_error) {
    throw new Error("Error during fetching positions");
  }
};
