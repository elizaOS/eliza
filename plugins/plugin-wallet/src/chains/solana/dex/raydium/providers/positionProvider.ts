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

const POSITION_LIMIT = 20;
const DEFAULT_SOLANA_RPC_URL = "https://api.mainnet-beta.solana.com";

type RaydiumClmmPoolInfo = {
  currentPrice: number;
  currentTickIndex: number;
  tickArrayLower: number;
  tickArrayUpper: number;
};

type RaydiumPositionRecord = {
  poolId: PublicKey;
  nftMint: PublicKey;
  tickLower: number;
  tickUpper: number;
};

async function loadRaydiumPositionApi(): Promise<{
  clmm: {
    getPool: (connection: Connection, poolId: PublicKey) => Promise<RaydiumClmmPoolInfo>;
  };
  position: {
    getPositionsByOwner: (
      connection: Connection,
      ownerAddress: PublicKey
    ) => Promise<Array<Record<string, unknown>>>;
  };
} | null> {
  const sdk = (await import("@raydium-io/raydium-sdk")) as Record<string, unknown>;
  const clmm = sdk.Clmm as
    | {
        getPool?: (connection: Connection, poolId: PublicKey) => Promise<RaydiumClmmPoolInfo>;
      }
    | undefined;
  const position = sdk.Position as
    | {
        getPositionsByOwner?: (
          connection: Connection,
          ownerAddress: PublicKey
        ) => Promise<Array<Record<string, unknown>>>;
      }
    | undefined;

  if (typeof clmm?.getPool !== "function" || typeof position?.getPositionsByOwner !== "function") {
    logger.warn(
      "Raydium LP position helper is unavailable in the installed Raydium SDK; returning no Raydium LP positions."
    );
    return null;
  }

  return {
    clmm: { getPool: clmm.getPool.bind(clmm) },
    position: { getPositionsByOwner: position.getPositionsByOwner.bind(position) },
  };
}

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
  contexts: ["finance", "crypto", "wallet"],
  contextGate: { anyOf: ["finance", "crypto", "wallet"] },
  cacheStable: false,
  cacheScope: "turn",
  roleGate: { minRole: "OWNER" },
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
      const privateKey = runtime.getSetting("SOLANA_PRIVATE_KEY");
      if (!privateKey || typeof privateKey !== "string") {
        logger.warn("SOLANA_PRIVATE_KEY not configured");
        return {
          text: "Raydium LP positions unavailable.",
          data: { positions: [], error: "SOLANA_PRIVATE_KEY not configured" },
          values: { positionCount: 0, hasPositions: false },
        };
      }

      // Decode the private key to get public address
      const bs58 = await import("bs58");
      const { Keypair } = await import("@solana/web3.js");
      const secretKey = bs58.default.decode(privateKey);
      const keypair = Keypair.fromSecretKey(secretKey);
      const ownerAddress = keypair.publicKey;

      const rpcUrl = getRuntimeStringSetting(runtime, "SOLANA_RPC_URL") ?? DEFAULT_SOLANA_RPC_URL;
      const connection = new Connection(rpcUrl);
      const positions = await fetchPositions(connection, ownerAddress);
      return {
        text: formatPositionsForPrompt(positions.slice(0, POSITION_LIMIT)),
        data: { positions: positions.slice(0, POSITION_LIMIT) },
      };
    } catch (error) {
      logger.error(`Error in Raydium position provider: ${formatUnknownError(error)}`);
      return {
        text: "Raydium LP positions unavailable.",
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
    const api = await loadRaydiumPositionApi();
    if (!api) return [];
    const { clmm, position: positionApi } = api;

    // Get all positions for the owner
    const positions = (await positionApi.getPositionsByOwner(connection, ownerAddress))
      .map(toRaydiumPositionRecord)
      .filter((position): position is RaydiumPositionRecord => position !== null);

    // Fetch all unique pools
    const poolsMap = new Map<string, RaydiumClmmPoolInfo>();

    // First pass: collect all pool addresses
    for (const position of positions) {
      if (!poolsMap.has(position.poolId.toString())) {
        const poolInfo = await clmm.getPool(connection, position.poolId);
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
    logger.error(`Error during fetching Raydium positions: ${formatUnknownError(error)}`);
    throw new Error("Error during fetching positions");
  }
};

function toRaydiumPositionRecord(position: Record<string, unknown>): RaydiumPositionRecord | null {
  const poolId = asPublicKey(position.poolId);
  const nftMint = asPublicKey(position.nftMint);
  const tickLower = position.tickLower;
  const tickUpper = position.tickUpper;

  if (!poolId || !nftMint || typeof tickLower !== "number" || typeof tickUpper !== "number") {
    logger.warn("Skipping Raydium LP position with unsupported SDK shape.");
    return null;
  }

  return {
    poolId,
    nftMint,
    tickLower,
    tickUpper,
  };
}

function asPublicKey(value: unknown): PublicKey | null {
  if (typeof value === "object" && value !== null && "toBase58" in value) {
    return value as PublicKey;
  }
  return null;
}

function getRuntimeStringSetting(runtime: IAgentRuntime, key: string): string | undefined {
  const value = runtime.getSetting(key);
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
