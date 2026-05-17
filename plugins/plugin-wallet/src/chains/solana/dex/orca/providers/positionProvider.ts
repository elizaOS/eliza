import {
  type IAgentRuntime,
  logger,
  type Memory,
  type Provider,
  type State,
  validateActionKeywords,
  validateActionRegex,
} from "@elizaos/core";
import { Connection, type PublicKey } from "@solana/web3.js";
import { loadWallet } from "../utils/loadWallet.ts";

const POSITION_LIMIT = 20;
const DEFAULT_SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";

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
    const __recentMessages = Array.isArray(state?.recentMessagesData)
      ? (state.recentMessagesData as Memory[])
      : [];
    const __isRelevant =
      validateActionKeywords(message, __recentMessages, __providerKeywords) ||
      validateActionRegex(message, __recentMessages, __providerRegex);
    if (!__isRelevant) {
      return { text: "" };
    }

    if (!state) {
      state = (await runtime.composeState(message)) as State;
    }
    try {
      const { address: ownerAddress } = await loadWallet(runtime, false);
      const rpcUrl = getRuntimeStringSetting(runtime, "SOLANA_RPC_URL") ?? DEFAULT_SOLANA_RPC_URL;
      const connection = new Connection(rpcUrl);
      const positions = await fetchPositions(connection, ownerAddress);
      return {
        text: formatPositionsForPrompt(positions.slice(0, POSITION_LIMIT)),
        data: { positions: positions.slice(0, POSITION_LIMIT) },
      };
    } catch (error) {
      logger.error(`Error in Orca position provider: ${formatUnknownError(error)}`);
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
  void connection;
  void ownerAddress;
  logger.warn(
    "Orca LP position helper is unavailable in the installed @orca-so/whirlpools-sdk; returning no Orca LP positions."
  );
  return [];
};

function getRuntimeStringSetting(runtime: IAgentRuntime, key: string): string | undefined {
  const value = runtime.getSetting(key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
