// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import {
  type Action,
  type ActionResult,
  elizaLogger,
  generateText,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelClass,
  parseJSONObjectFromText,
  type State,
  settings,
} from "@elizaos/core";
import {
  Clmm,
  type ClmmPoolInfo,
  collectRewardInstructionV2,
  createClosePositionInstruction,
  createOpenPositionInstruction,
  decreaseLiquidityInstructionV2,
  increaseLiquidityInstructionV2,
  Position,
  type PositionInfo,
} from "@raydium-io/raydium-sdk";
import { Connection, type Keypair, PublicKey, type TransactionInstruction } from "@solana/web3.js";

const RAYDIUM_POSITION_PROVIDER = "degen-lp-raydium-position-provider";

function extractRaydiumPositionsFromState(state: State): FetchedPosition[] {
  const providers = state.providers;
  if (!Array.isArray(providers)) {
    throw new Error("No providers array on state");
  }
  for (const entry of providers) {
    if (typeof entry !== "object" || entry === null || !("name" in entry)) continue;
    const name = (entry as { name?: string }).name;
    if (name !== RAYDIUM_POSITION_PROVIDER) continue;
    const data = (entry as { data?: unknown }).data;
    if (Array.isArray(data)) return data as FetchedPosition[];
    if (
      data &&
      typeof data === "object" &&
      Array.isArray((data as { positions?: unknown }).positions)
    ) {
      return (data as { positions: FetchedPosition[] }).positions;
    }
    if (typeof data === "string") return JSON.parse(data) as FetchedPosition[];
    throw new Error("Raydium provider data must include positions");
  }
  throw new Error("No Raydium position data found");
}

interface FetchedPosition {
  poolId: string;
  positionMint: string;
  inRange: boolean;
  distanceCenterPositionFromPoolPriceBps: number;
  positionWidthBps: number;
}

interface NewPriceBounds {
  newLowerPrice: number;
  newUpperPrice: number;
}

interface ManagePositionsInput {
  repositionThresholdBps: number;
  intervalSeconds: number;
  slippageToleranceBps: number;
}

interface PoolData {
  poolInfo: ClmmPoolInfo;
  positionInfo: PositionInfo;
  tokenAInfo: {
    mint: PublicKey;
    decimals: number;
  };
  tokenBInfo: {
    mint: PublicKey;
    decimals: number;
  };
}

const REBALANCE_SUMMARY_LIMIT = 5;

function toActionError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function buildActionResult(
  success: boolean,
  text: string,
  data?: Record<string, unknown>,
  error?: string
): ActionResult {
  return { success, text, data, ...(error ? { error } : {}) };
}

function readManagePositionsOptions(
  params: Record<string, unknown> | undefined
): ManagePositionsInput | null {
  if (!params) return null;
  try {
    return validateManagePositionsInput(params);
  } catch {
    return null;
  }
}

function selectedContextMatches(state: State | undefined, contexts: readonly string[]): boolean {
  const selected = new Set<string>();
  const collect = (value: unknown) => {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (typeof item === "string") selected.add(item);
    }
  };
  collect((state?.values as Record<string, unknown> | undefined)?.selectedContexts);
  collect((state?.data as Record<string, unknown> | undefined)?.selectedContexts);
  const contextObject = (state?.data as Record<string, unknown> | undefined)?.contextObject as
    | {
        trajectoryPrefix?: { selectedContexts?: unknown };
        metadata?: { selectedContexts?: unknown };
      }
    | undefined;
  collect(contextObject?.trajectoryPrefix?.selectedContexts);
  collect(contextObject?.metadata?.selectedContexts);
  return contexts.some((context) => selected.has(context));
}

export const managePositions: Action = {
  name: "manage_raydium_positions",
  contexts: ["finance", "crypto", "wallet"],
  contextGate: { anyOf: ["finance", "crypto", "wallet"] },
  roleGate: { minRole: "USER" },
  similes: [
    "AUTOMATE_RAYDIUM_REBALANCING",
    "AUTOMATE_RAYDIUM_POSITIONS",
    "START_MANAGING_RAYDIUM_POSITIONS",
  ],
  description:
    "Automatically manage Raydium positions by rebalancing them when they drift too far from the pool price",
  descriptionCompressed: "automatically manage Raydium position rebalance drift too far pool price",
  parameters: [
    {
      name: "repositionThresholdBps",
      description: "Required drift threshold in basis points before rebalancing.",
      required: true,
      schema: { type: "integer", minimum: 1, maximum: 10000 },
    },
    {
      name: "intervalSeconds",
      description: "Requested monitoring interval in seconds for the automation policy.",
      required: true,
      schema: { type: "integer", minimum: 1, maximum: 86400 },
    },
    {
      name: "slippageToleranceBps",
      description: "Required slippage tolerance in basis points for reopen transactions.",
      required: true,
      schema: { type: "integer", minimum: 1, maximum: 5000 },
    },
  ],

  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    if (selectedContextMatches(state, ["finance", "crypto", "wallet"])) {
      return true;
    }
    const __avTextRaw = typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["manage", "raydium", "positions"];
    const __avKeywordOk =
      __avKeywords.length > 0 && __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
    const __avRegex = /\b(?:manage|raydium|positions)\b/i;
    const __avRegexOk = __avRegex.test(__avText);
    const __avSource = String(message?.content?.source ?? "");
    const __avExpectedSource = "";
    const __avSourceOk = __avExpectedSource
      ? __avSource === __avExpectedSource
      : Boolean(__avSource || state || runtime?.agentId || runtime?.getService);
    const __avInputOk =
      __avText.trim().length > 0 ||
      Boolean(message?.content && typeof message.content === "object");

    if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
      return false;
    }

    const __avLegacyValidate = async (
      runtime: IAgentRuntime,
      message: Memory
    ): Promise<boolean> => {
      const config = await extractAndValidateConfiguration(message.content.text, runtime);
      if (!config) {
        elizaLogger.warn("Validation failed: No valid configuration provided.");
        return false;
      }
      if (
        config.repositionThresholdBps <= 0 ||
        config.intervalSeconds <= 0 ||
        config.slippageToleranceBps <= 0
      ) {
        return false;
      }
      return true;
    };
    try {
      return Boolean(await __avLegacyValidate(runtime, message));
    } catch {
      return false;
    }
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    params: { [key: string]: unknown },
    _callback?: HandlerCallback
  ): Promise<ActionResult> => {
    elizaLogger.log("Start managing Raydium positions");
    try {
      if (!state) {
        state = (await runtime.composeState(message)) as State;
      } else {
        state = await runtime.updateRecentMessageState(state);
      }

      const config =
        readManagePositionsOptions(params) ??
        (await extractAndValidateConfiguration(message.content.text, runtime));
      if (!config) {
        return buildActionResult(
          false,
          "Missing or invalid Raydium position-management config. Provide repositionThresholdBps, intervalSeconds, and slippageToleranceBps.",
          { providedParams: Object.keys(params ?? {}) },
          "INVALID_MANAGE_POSITIONS_CONFIG"
        );
      }

      const { repositionThresholdBps, intervalSeconds, slippageToleranceBps } = config;
      const fetchedPositions = extractRaydiumPositionsFromState(state);
      elizaLogger.log(
        `Validated configuration: repositionThresholdBps=${repositionThresholdBps}, slippageTolerance=${slippageToleranceBps}`
      );
      const { signer: wallet } = await loadWallet(runtime, true);
      const solanaRpcUrl = settings.SOLANA_RPC_URL;
      if (!solanaRpcUrl) {
        return buildActionResult(
          false,
          "SOLANA_RPC_URL setting is required to manage Raydium positions.",
          undefined,
          "SOLANA_RPC_URL setting is required to manage Raydium positions."
        );
      }
      const connection = new Connection(solanaRpcUrl);

      const results = await handleRepositioning(
        fetchedPositions,
        repositionThresholdBps,
        connection,
        wallet
      );
      const changed = results.filter((item): item is NonNullable<(typeof results)[number]> =>
        Boolean(item)
      );
      const unchangedCount = fetchedPositions.length - changed.length;
      return buildActionResult(
        true,
        changed.length > 0
          ? `Managed ${fetchedPositions.length} Raydium positions; rebalanced ${changed.length} and skipped ${unchangedCount}.`
          : `Checked ${fetchedPositions.length} Raydium positions; all remained in range.`,
        {
          config: { repositionThresholdBps, intervalSeconds, slippageToleranceBps },
          totalPositions: fetchedPositions.length,
          rebalancedCount: changed.length,
          skippedCount: unchangedCount,
          rebalancedPositions: changed.slice(0, REBALANCE_SUMMARY_LIMIT).map((item) => ({
            positionMint: item.positionMint,
            closeTxId: item.closeTxId,
            openTxId: item.openTxId,
          })),
        }
      );
    } catch (error) {
      const errorMessage = toActionError(error);
      return buildActionResult(
        false,
        `Failed to manage Raydium positions: ${errorMessage}`,
        { providedParams: Object.keys(params ?? {}) },
        errorMessage
      );
    }
  },
  examples: [],
};

function validateManagePositionsInput(obj: Record<string, unknown>): ManagePositionsInput {
  const repositionThresholdBps = readInteger(obj.repositionThresholdBps);
  const intervalSeconds = readInteger(obj.intervalSeconds);
  const slippageToleranceBps = readInteger(obj.slippageToleranceBps);
  if (
    repositionThresholdBps === null ||
    intervalSeconds === null ||
    slippageToleranceBps === null
  ) {
    throw new Error("Invalid input: Object does not match the ManagePositionsInput type.");
  }
  return { repositionThresholdBps, intervalSeconds, slippageToleranceBps };
}

function readInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) ? parsed : null;
}

export async function extractAndValidateConfiguration(
  text: string,
  runtime: IAgentRuntime
): Promise<ManagePositionsInput | null> {
  elizaLogger.log("Extracting and validating configuration from text:", text);

  const prompt = `Given this message: "${text}". Extract the reposition threshold value, time interval, and slippage tolerance.
        The threshold value and the slippage tolerance can be given in percentages or bps. You will always respond with the reposition threshold in bps.
        Very important: Use null for each field that is not present in the message.
        Respond with JSON only using this shape:
        {
          "repositionThresholdBps": 120,
          "intervalSeconds": 300,
          "slippageToleranceBps": 50
        }
    `;

  const content = await generateText({
    runtime,
    context: prompt,
    modelClass: ModelClass.SMALL,
  });

  try {
    const configuration = parseJSONObjectFromText(content) as Record<string, unknown> | null;
    if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
      throw new Error("Configuration must be a structured object");
    }
    return validateManagePositionsInput(configuration as Record<string, unknown>);
  } catch (error) {
    elizaLogger.warn("Invalid configuration detected:", error);
    return null;
  }
}

async function calculateNewPositionBounds(
  poolId: string,
  positionWidthBps: number
): Promise<NewPriceBounds> {
  const response = await fetch(`${settings.RAYDIUM_API_URL}/pools/info/ids?ids=${poolId}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch pool data: ${response.statusText}`);
  }

  const result = await response.json();
  if (!result.success) {
    throw new Error(`API error: ${result.msg}`);
  }

  const currentPrice = result.data[0].price;
  const halfWidth = positionWidthBps / 2;

  return {
    newLowerPrice: currentPrice * (1 - halfWidth / 10000),
    newUpperPrice: currentPrice * (1 + halfWidth / 10000),
  };
}

async function createClosePositionInstructions(
  positionMint: string,
  owner: PublicKey,
  connection: Connection
): Promise<TransactionInstruction[]> {
  try {
    // Fetch position data
    const positionPubkey = new PublicKey(positionMint);
    const position = await Position.getPosition(connection, positionPubkey);
    if (!position) {
      throw new Error("Position not found");
    }

    // Fetch pool data
    const poolData = await fetchPoolData(position.poolId.toString(), connection);

    // Create instructions to collect fees and rewards first
    const collectFeesInstructions = await collectRewardInstructionV2({
      poolInfo: poolData.poolInfo,
      positionInfo: poolData.positionInfo,
      ownerInfo: {
        wallet: owner,
        tokenAccounts: await getTokenAccounts(connection, owner),
      },
      connection,
    });

    // Create instruction to remove all liquidity
    const removeLiquidityInstructions = await decreaseLiquidityInstructionV2({
      poolInfo: poolData.poolInfo,
      positionInfo: poolData.positionInfo,
      ownerInfo: {
        wallet: owner,
        tokenAccounts: await getTokenAccounts(connection, owner),
      },
      liquidity: poolData.positionInfo.liquidity,
      connection,
    });

    // Create instruction to close position
    const closeInstruction = await createClosePositionInstruction({
      poolInfo: poolData.poolInfo,
      positionInfo: poolData.positionInfo,
      owner,
      connection,
    });

    // Combine all instructions
    return [...collectFeesInstructions, ...removeLiquidityInstructions, closeInstruction];
  } catch (error) {
    elizaLogger.error("Error creating close position instructions:", error);
    throw error;
  }
}

async function createOpenPositionInstructions(
  poolId: string,
  bounds: NewPriceBounds,
  owner: PublicKey,
  connection: Connection
): Promise<TransactionInstruction[]> {
  try {
    // Fetch pool data
    const poolData = await fetchPoolData(poolId, connection);

    // Calculate ticks from prices
    const lowerTick = Clmm.getPriceToTickIndex(
      bounds.newLowerPrice,
      poolData.tokenAInfo.decimals,
      poolData.tokenBInfo.decimals,
      poolData.poolInfo.tickSpacing
    );
    const upperTick = Clmm.getPriceToTickIndex(
      bounds.newUpperPrice,
      poolData.tokenAInfo.decimals,
      poolData.tokenBInfo.decimals,
      poolData.poolInfo.tickSpacing
    );

    // Create open position instruction
    const openInstruction = await createOpenPositionInstruction({
      poolInfo: poolData.poolInfo,
      ownerInfo: {
        wallet: owner,
        tokenAccounts: await getTokenAccounts(connection, owner),
      },
      tickLower: lowerTick,
      tickUpper: upperTick,
      connection,
    });

    // Create instruction to add initial liquidity
    const addLiquidityInstructions = await increaseLiquidityInstructionV2({
      poolInfo: poolData.poolInfo,
      ownerInfo: {
        wallet: owner,
        tokenAccounts: await getTokenAccounts(connection, owner),
      },
      tickLower: lowerTick,
      tickUpper: upperTick,
      // You'll need to calculate the optimal liquidity amount based on your strategy
      liquidityInput: calculateOptimalLiquidity(poolData, bounds),
      connection,
    });

    return [...openInstruction, ...addLiquidityInstructions];
  } catch (error) {
    elizaLogger.error("Error creating open position instructions:", error);
    throw error;
  }
}

async function fetchPoolData(poolId: string, connection: Connection): Promise<PoolData> {
  // Fetch pool info from Raydium API
  const response = await fetch(`${settings.RAYDIUM_API_URL}/pools/info/ids?ids=${poolId}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch pool data: ${response.statusText}`);
  }

  const result = await response.json();
  if (!result.success) {
    throw new Error(`API error: ${result.msg}`);
  }

  const poolInfo = result.data[0];

  // Get on-chain pool data
  const clmmPool = await Clmm.getPool(connection, new PublicKey(poolId));
  if (!clmmPool) {
    throw new Error("Pool not found on-chain");
  }

  return {
    poolInfo: clmmPool,
    positionInfo: await Position.getPositionsByPool(connection, new PublicKey(poolId)),
    tokenAInfo: {
      mint: new PublicKey(poolInfo.tokenA.mint),
      decimals: poolInfo.tokenA.decimals,
    },
    tokenBInfo: {
      mint: new PublicKey(poolInfo.tokenB.mint),
      decimals: poolInfo.tokenB.decimals,
    },
  };
}

async function getTokenAccounts(
  connection: Connection,
  owner: PublicKey
): Promise<Map<string, { tokenAccount: PublicKey }>> {
  const tokenAccounts = new Map();
  const response = await connection.getParsedTokenAccountsByOwner(owner, {
    programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  });

  for (const { account, pubkey } of response.value) {
    const mintAddress = account.data.parsed.info.mint;
    tokenAccounts.set(mintAddress, {
      tokenAccount: pubkey,
    });
  }

  return tokenAccounts;
}

function calculateOptimalLiquidity(poolData: PoolData, bounds: NewPriceBounds): bigint {
  // Get current pool price
  const currentPrice = poolData.poolInfo.currentPrice;

  // Calculate the geometric mean price as the center of our range
  const geometricMeanPrice = Math.sqrt(bounds.newLowerPrice * bounds.newUpperPrice);

  // Calculate the ratio of token amounts based on the geometric mean price
  const priceRatio = currentPrice / geometricMeanPrice;

  // Get pool reserves
  const tokenAReserves = poolData.poolInfo.tokenA.vault.amount;
  const tokenBReserves = poolData.poolInfo.tokenB.vault.amount;

  // Calculate optimal ratio of tokens for the position
  const sqrtRatio = Math.sqrt(priceRatio);
  const tokenARatio = 1 / sqrtRatio;
  const tokenBRatio = sqrtRatio;

  // Calculate liquidity based on smaller of the two token amounts
  // This ensures we don't exceed available liquidity
  const liquidityFromA =
    (BigInt(tokenAReserves) * BigInt(Math.floor(tokenARatio * 1e6))) / BigInt(1e6);
  const liquidityFromB =
    (BigInt(tokenBReserves) * BigInt(Math.floor(tokenBRatio * 1e6))) / BigInt(1e6);

  // Use the smaller of the two liquidity amounts
  return liquidityFromA < liquidityFromB ? liquidityFromA : liquidityFromB;
}

async function handleRepositioning(
  fetchedPositions: FetchedPosition[],
  repositionThresholdBps: number,
  connection: Connection,
  wallet: Keypair
) {
  return await Promise.all(
    fetchedPositions.map(async (position) => {
      const { inRange, distanceCenterPositionFromPoolPriceBps } = position;
      if (!inRange || distanceCenterPositionFromPoolPriceBps > repositionThresholdBps) {
        elizaLogger.log(`Repositioning needed for position ${position.positionMint}`);

        try {
          // Calculate new position bounds
          const newBounds = await calculateNewPositionBounds(
            position.poolId,
            position.positionWidthBps
          );

          // Close existing position
          let closeSuccess = false;
          let closeTxId: string | undefined;
          while (!closeSuccess) {
            try {
              const closeInstructions = await createClosePositionInstructions(
                position.positionMint,
                wallet.publicKey,
                connection
              );
              closeTxId = await sendTransaction(closeInstructions, wallet, connection);
              closeSuccess = !!closeTxId;
            } catch (closeError) {
              elizaLogger.warn(
                `Close position failed for ${position.positionMint}, retrying. Error: ${closeError}`
              );
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          }

          // Open new position
          let openSuccess = false;
          let openTxId: string | undefined;
          while (!openSuccess) {
            try {
              const openInstructions = await createOpenPositionInstructions(
                position.poolId,
                newBounds,
                wallet.publicKey,
                connection
              );
              openTxId = await sendTransaction(openInstructions, wallet, connection);
              openSuccess = !!openTxId;

              elizaLogger.log(`Successfully repositioned ${position.positionMint}`);
              return {
                positionMint: position.positionMint,
                closeTxId,
                openTxId,
              };
            } catch (openError) {
              elizaLogger.warn(
                `Open position failed for ${position.positionMint}, retrying. Error: ${openError}`
              );
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          }
        } catch (error) {
          elizaLogger.error(`Failed to reposition ${position.positionMint}:`, error);
        }
      } else {
        elizaLogger.log(`Position ${position.positionMint} is in range, skipping.`);
        return null;
      }
    })
  );
}
