import {
  elizaLogger,
  type IAgentRuntime,
  type Memory,
  type Provider,
  type State,
  validateActionKeywords,
  validateActionRegex,
} from "@elizaos/core";
import { type Connection, PublicKey } from "@solana/web3.js";
import { DLMM } from "../utils/dlmm.ts";
import { loadWallet } from "../utils/loadWallet.ts";

export interface MeteoraPositionStatistics {
  poolAddress: string;
  positionPubKey: string;
  inRange: boolean;
  distanceFromActiveBinBps: number;
  binRange: number;
}

export const meteoraPositionProvider: Provider = {
  name: "degen-lp-meteora-position-provider",
  description: "Provides Meteora LP position information for the current wallet",
  descriptionCompressed: "provide Meteora LP position information current wallet",
  dynamic: true,
  contexts: ["finance", "crypto", "wallet"],
  contextGate: { anyOf: ["finance", "crypto", "wallet"] },
  cacheStable: false,
  cacheScope: "turn",
  roleGate: { minRole: "OWNER" },
  relevanceKeywords: [
    "degen",
    "meteora",
    "position",
    "meteorapositionprovider",
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
  ],
  get: async (runtime: IAgentRuntime, message: Memory, state?: State) => {
    const __providerKeywords = [
      "degen",
      "meteora",
      "position",
      "meteorapositionprovider",
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
      const { address: ownerAddress, connection } = await loadWallet(runtime, false);
      if (!ownerAddress) {
        elizaLogger.error("Could not load wallet address");
        return {
          data: {
            positions: [],
            error: "No wallet address found",
          },
          values: {
            positionCount: 0,
            hasPositions: false,
          },
          text: "No wallet address found. Unable to fetch Meteora positions.",
        };
      }

      const positions = await fetchPositions(
        connection,
        ownerAddress,
        resolveMeteoraPoolAddresses(runtime)
      );
      const positionCount = positions.length;
      const inRangeCount = positions.filter((p) => p.inRange).length;

      let positionText = "";
      if (positionCount === 0) {
        positionText = "No Meteora LP positions found.";
      } else {
        positionText = `Found ${positionCount} Meteora LP position${positionCount > 1 ? "s" : ""}. ${inRangeCount} ${inRangeCount === 1 ? "is" : "are"} currently in range.`;

        // Add details for each position
        positions.forEach((pos, index) => {
          positionText += `\n\nPosition ${index + 1}:`;
          positionText += `\n- Pool: ${pos.poolAddress.slice(0, 8)}...`;
          positionText += `\n- In Range: ${pos.inRange ? "Yes" : "No"}`;
          positionText += `\n- Distance from Active Bin: ${pos.distanceFromActiveBinBps} bps`;
          positionText += `\n- Bin Range: ${pos.binRange}`;
        });
      }

      return {
        data: {
          positions,
          positionCount,
          inRangeCount,
        },
        values: {
          positionCount,
          hasPositions: positionCount > 0,
          inRangeCount,
        },
        text: positionText,
      };
    } catch (error) {
      elizaLogger.error(`Error in Meteora position provider: ${formatUnknownError(error)}`);
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      return {
        data: {
          positions: [],
          error: errorMessage,
        },
        values: {
          positionCount: 0,
          hasPositions: false,
        },
        text: `Error fetching Meteora positions: ${errorMessage}`,
      };
    }
  },
};

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const fetchPositions = async (
  connection: Connection,
  ownerAddress: PublicKey,
  poolAddresses: readonly string[]
): Promise<MeteoraPositionStatistics[]> => {
  try {
    const positions: MeteoraPositionStatistics[] = [];

    for (const poolAddress of poolAddresses) {
      // Connection type compatibility - DLMM may expect a different Connection version
      const dlmmPool = await DLMM.create(
        connection as Parameters<typeof DLMM.create>[0],
        new PublicKey(poolAddress)
      );
      const { userPositions } = await dlmmPool.getPositionsByUserAndLbPair(ownerAddress);
      const activeBin = await dlmmPool.getActiveBin();

      for (const position of userPositions) {
        const binData = position.positionData.positionBinData;
        const positionBinIds = binData.map((b: { binId: number }) => b.binId);
        const binRange = Math.max(...positionBinIds) - Math.min(...positionBinIds);

        const centerBinId = Math.floor(
          (Math.max(...positionBinIds) + Math.min(...positionBinIds)) / 2
        );

        const distanceFromActiveBinBps = Math.abs(centerBinId - activeBin.binId) * 100;

        positions.push({
          poolAddress: poolAddress.toString(),
          positionPubKey: position.publicKey.toString(),
          inRange: positionBinIds.includes(activeBin.binId),
          distanceFromActiveBinBps,
          binRange,
        });
      }
    }

    return positions;
  } catch (error) {
    throw new Error(`Error fetching Meteora positions: ${error}`);
  }
};

const DEFAULT_METEORA_POOL_ADDRESSES = [
  "ARwi1S4DaiTG5DX7S4M4ZsrXqpMD1MrTmbu9ue2tpmEq", // USDC/USDT
] as const;

function resolveMeteoraPoolAddresses(runtime: IAgentRuntime): readonly string[] {
  const configured = runtime.getSetting("METEORA_POOL_ADDRESSES");
  if (typeof configured !== "string" || configured.trim().length === 0) {
    return DEFAULT_METEORA_POOL_ADDRESSES;
  }

  const addresses = configured
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);

  if (addresses.length === 0) {
    return DEFAULT_METEORA_POOL_ADDRESSES;
  }

  return addresses.map((address) => {
    try {
      return new PublicKey(address).toBase58();
    } catch {
      throw new Error(`Invalid METEORA_POOL_ADDRESSES entry: ${address}`);
    }
  });
}
