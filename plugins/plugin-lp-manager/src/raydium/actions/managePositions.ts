import {
  Action,
  elizaLogger,
  generateText,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  ModelClass,
  parseJSONObjectFromText,
  settings,
  State,
} from "@elizaos/core";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";

import {
  Clmm,
  ClmmPoolInfo,
  Position,
  PositionInfo,
  decreaseLiquidityInstructionV2,
  increaseLiquidityInstructionV2,
  collectRewardInstructionV2,
  createClosePositionInstruction,
  createOpenPositionInstruction,
  getAssociatedTokenAddressSync,
} from "@raydium-io/raydium-sdk";

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

export const managePositions: Action = {
  name: "manage_raydium_positions",
  similes: [
    "AUTOMATE_RAYDIUM_REBALANCING",
    "AUTOMATE_RAYDIUM_POSITIONS",
    "START_MANAGING_RAYDIUM_POSITIONS",
  ],
  description:
    "Automatically manage Raydium positions by rebalancing them when they drift too far from the pool price",

  validate: async (
    runtime: IAgentRuntime,
    message: Memory
  ): Promise<boolean> => {
    const config = await extractAndValidateConfiguration(
      message.content.text,
      runtime
    );
    if (!config) {
      elizaLogger.warn("Validation failed: No valid configuration provided.");
      return false;
    }
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    params: { [key: string]: unknown },
    callback?: HandlerCallback
  ) => {
    elizaLogger.log("Start managing Raydium positions");
    if (!state) {
      state = (await runtime.composeState(message)) as State;
    } else {
      state = await runtime.updateRecentMessageState(state);
    }

    const {
      repositionThresholdBps,
      slippageToleranceBps,
    }: ManagePositionsInput = await extractAndValidateConfiguration(
      message.content.text,
      runtime
    );
    const fetchedPositions = await extractFetchedPositions(
      state.providers,
      runtime
    );

    elizaLogger.log(
      `Validated configuration: repositionThresholdBps=${repositionThresholdBps}, slippageTolerance=${slippageToleranceBps}`
    );
    elizaLogger.log("Fetched positions:", fetchedPositions);

    const { signer: wallet } = await loadWallet(runtime, true);
    const connection = new Connection(settings.SOLANA_RPC_URL!);

    await handleRepositioning(
      fetchedPositions,
      repositionThresholdBps,
      connection,
      wallet
    );

    return true;
  },
  examples: [],
};

async function extractFetchedPositions(
  providers: any,
  runtime: IAgentRuntime
): Promise<FetchedPosition[]> {
  const raydiumProvider = providers.find(
    (p: any) => p.name === "degen-lp-raydium-position-provider"
  );
  if (!raydiumProvider || !raydiumProvider.data) {
    throw new Error("No Raydium position data found");
  }
  return JSON.parse(raydiumProvider.data);
}

function validateManagePositionsInput(
  obj: Record<string, any>
): ManagePositionsInput {
  if (
    typeof obj.repositionThresholdBps !== "number" ||
    !Number.isInteger(obj.repositionThresholdBps) ||
    typeof obj.intervalSeconds !== "number" ||
    !Number.isInteger(obj.intervalSeconds) ||
    typeof obj.slippageToleranceBps !== "number" ||
    !Number.isInteger(obj.slippageToleranceBps)
  ) {
    throw new Error(
      "Invalid input: Object does not match the ManagePositionsInput type."
    );
  }
  return obj as ManagePositionsInput;
}

export async function extractAndValidateConfiguration(
  text: string,
  runtime: IAgentRuntime
): Promise<ManagePositionsInput | null> {
  elizaLogger.log("Extracting and validating configuration from text:", text);

  const prompt = `Given this message: "${text}". Extract the reposition threshold value, time interval, and slippage tolerance.
        The threshold value and the slippage tolerance can be given in percentages or bps. You will always respond with the reposition threshold in bps.
        Very important: Add null values for each field that is not present in the message.
        Return the response as a JSON object with the following structure:
        {
            "repositionThresholdBps": number (integer value),
            "intervalSeconds": number (integer value),
            "slippageToleranceBps": number (integer value)
        }
    `;

  const content = await generateText({
    runtime,
    context: prompt,
    modelClass: ModelClass.SMALL,
  });

  try {
    const configuration = parseJSONObjectFromText(content);
    return validateManagePositionsInput(configuration);
  } catch (error) {
    elizaLogger.warn("Invalid configuration detected:", error);
    return null;
  }
}

async function calculateNewPositionBounds(
  poolId: string,
  positionWidthBps: number
): Promise<NewPriceBounds> {
  const response = await fetch(
    `${settings.RAYDIUM_API_URL}/pools/info/ids?ids=${poolId}`
  );
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
): Promise<any> {
  try {
    // Fetch position data
    const positionPubkey = new PublicKey(positionMint);
    const position = await Position.getPosition(connection, positionPubkey);
    if (!position) {
      throw new Error("Position not found");
    }

    // Fetch pool data
    const poolData = await fetchPoolData(
      position.poolId.toString(),
      connection
    );

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
    return [
      ...collectFeesInstructions,
      ...removeLiquidityInstructions,
      closeInstruction,
    ];
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
): Promise<any> {
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

async function fetchPoolData(
  poolId: string,
  connection: Connection
): Promise<PoolData> {
  // Fetch pool info from Raydium API
  const response = await fetch(
    `${settings.RAYDIUM_API_URL}/pools/info/ids?ids=${poolId}`
  );
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
    positionInfo: await Position.getPositionsByPool(
      connection,
      new PublicKey(poolId)
    ),
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

function calculateOptimalLiquidity(
  poolData: PoolData,
  bounds: NewPriceBounds
): bigint {
  // Get current pool price
  const currentPrice = poolData.poolInfo.currentPrice;

  // Calculate the geometric mean price as the center of our range
  const geometricMeanPrice = Math.sqrt(
    bounds.newLowerPrice * bounds.newUpperPrice
  );

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
    (BigInt(tokenAReserves) * BigInt(Math.floor(tokenARatio * 1e6))) /
    BigInt(1e6);
  const liquidityFromB =
    (BigInt(tokenBReserves) * BigInt(Math.floor(tokenBRatio * 1e6))) /
    BigInt(1e6);

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
      if (
        !inRange ||
        distanceCenterPositionFromPoolPriceBps > repositionThresholdBps
      ) {
        elizaLogger.log(
          `Repositioning needed for position ${position.positionMint}`
        );

        try {
          // Calculate new position bounds
          const newBounds = await calculateNewPositionBounds(
            position.poolId,
            position.positionWidthBps
          );

          // Close existing position
          let closeSuccess = false;
          let closeTxId;
          while (!closeSuccess) {
            try {
              const closeInstructions = await createClosePositionInstructions(
                position.positionMint,
                wallet.publicKey,
                connection
              );
              closeTxId = await sendTransaction(
                closeInstructions,
                wallet,
                connection
              );
              closeSuccess = closeTxId ? true : false;
            } catch (closeError) {
              elizaLogger.warn(
                `Close position failed for ${position.positionMint}, retrying. Error: ${closeError}`
              );
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          }

          // Open new position
          let openSuccess = false;
          let openTxId;
          while (!openSuccess) {
            try {
              const openInstructions = await createOpenPositionInstructions(
                position.poolId,
                newBounds,
                wallet.publicKey,
                connection
              );
              openTxId = await sendTransaction(
                openInstructions,
                wallet,
                connection
              );
              openSuccess = openTxId ? true : false;

              elizaLogger.log(
                `Successfully repositioned ${position.positionMint}`
              );
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
          elizaLogger.error(
            `Failed to reposition ${position.positionMint}:`,
            error
          );
        }
      } else {
        elizaLogger.log(
          `Position ${position.positionMint} is in range, skipping.`
        );
        return null;
      }
    })
  );
}
