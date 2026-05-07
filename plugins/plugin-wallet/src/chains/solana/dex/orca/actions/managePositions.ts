// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import {
  type AgentRuntime,
  type actions,
  elizaLogger,
  generateText,
  type HandlerCallback,
  type Memory,
  ModelClass,
  parseJSONObjectFromText,
  type State,
  settings,
} from "@elizaos/core";
import {
  closePositionInstructions,
  type IncreaseLiquidityQuoteParam,
  openPositionInstructions,
  setDefaultFunder,
  setDefaultSlippageToleranceBps,
} from "@orca-so/whirlpools";
import { fetchPosition, fetchWhirlpool, getPositionAddress } from "@orca-so/whirlpools-client";
import { sqrtPriceToPrice } from "@orca-so/whirlpools-core";
import { getMint } from "@solana/spl-token";
import {
  type Connection,
  type Keypair as KeyPairSigner,
  PublicKey,
  Connection as SolanaRpc,
} from "@solana/web3.js";
import { loadWallet } from "../utils/loadWallet";
import { sendTransaction } from "../utils/sendTransaction";

interface FetchedPosition {
  whirlpoolAddress: string;
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

const ORCA_POSITION_PROVIDER = "orca-lp-position-provider";

function extractOrcaPositionsFromState(state: State): FetchedPosition[] {
  const providers = state.providers;
  if (!Array.isArray(providers)) {
    throw new Error("No providers array on state");
  }
  for (const entry of providers) {
    if (typeof entry !== "object" || entry === null || !("name" in entry)) continue;
    const name = (entry as { name?: string }).name;
    if (name !== ORCA_POSITION_PROVIDER) continue;
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
    throw new Error("Orca provider data must include positions");
  }
  throw new Error("No Orca position data found");
}

export const managePositions: typeof actions = {
  name: "manage_positions",
  similes: ["AUTOMATE_REBALANCING", "AUTOMATE_POSITIONS", "START_MANAGING_POSITIONS"],
  description:
    "Automatically manage positions by rebalancing them when they drift too far from the pool price",
  descriptionCompressed: "automatically manage position rebalance drift too far pool price",

  validate: async (runtime: AgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const __avTextRaw = typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["manage", "position", "rebalance", "liquidity", "orca"];
    const __avKeywordOk =
      __avKeywords.length > 0 && __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
    const __avRegex = /\b(?:manage|position|rebalance|liquidity|orca)\b/i;
    const __avRegexOk = __avRegex.test(__avText);
    const __avSource = String(message?.content?.source ?? "");
    const __avExpectedSource = "";
    const __avSourceOk = __avExpectedSource
      ? __avSource === __avExpectedSource
      : Boolean(__avSource || state || runtime?.agentId || runtime?.composeState);
    const __avInputOk =
      __avText.trim().length > 0 ||
      Boolean(message?.content && typeof message.content === "object");

    if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
      return false;
    }

    const __avLegacyValidate = async (runtime: AgentRuntime, message: Memory): Promise<boolean> => {
      const config = await extractAndValidateConfiguration(message.content.text, runtime);
      if (!config) {
        elizaLogger.warn("Validation failed: No valid configuration provided.");
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
    runtime: AgentRuntime,
    message: Memory,
    state: State,
    _params: { [key: string]: unknown },
    _callback?: HandlerCallback
  ) => {
    elizaLogger.log("Start managing positions");
    if (!state) {
      state = (await runtime.composeState(message)) as State;
    } else {
      state = await runtime.updateRecentMessageState(state);
    }
    const { repositionThresholdBps, slippageToleranceBps }: ManagePositionsInput =
      await extractAndValidateConfiguration(message.content.text, runtime);
    const fetchedPositions = extractOrcaPositionsFromState(state);
    elizaLogger.log(
      `Validated configuration: repositionThresholdBps=${repositionThresholdBps}, slippageTolerance=${slippageToleranceBps}`
    );
    elizaLogger.log("Fetched positions:", fetchedPositions);

    const { signer: wallet } = await loadWallet(runtime, true);
    const solanaRpcUrl = settings.SOLANA_RPC_URL;
    if (!solanaRpcUrl) {
      throw new Error("SOLANA_RPC_URL setting is required to manage Orca positions.");
    }
    const rpc = createSolanaRpc(solanaRpcUrl);
    setDefaultSlippageToleranceBps(slippageToleranceBps);
    setDefaultFunder(wallet);

    await handleRepositioning(fetchedPositions, repositionThresholdBps, rpc, wallet);

    return true;
  },
  examples: [
    [
      {
        name: "{{userName}}",
        content: {
          text: "Start managing my Orca positions and rebalance when drift exceeds 100 bps every 5 minutes",
          action: "manage_positions",
        },
      },
    ],
    [
      {
        name: "{{userName}}",
        content: {
          text: "Automatically rebalance LP positions with 0.5% slippage and 150 bps threshold",
          action: "manage_positions",
        },
      },
    ],
    [
      {
        name: "{{userName}}",
        content: {
          text: "Gestiona mis posiciones de liquidez y rebalancea si se salen del rango",
          action: "manage_positions",
        },
      },
    ],
    [
      {
        name: "{{userName}}",
        content: {
          text: "Keep my Orca LP centered; rebalance every 300 seconds",
          action: "manage_positions",
        },
      },
    ],
    [
      {
        name: "{{userName}}",
        content: {
          text: "管理我的流动性仓位，偏离超过 120bps 就自动再平衡",
          action: "manage_positions",
        },
      },
    ],
  ],
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
  runtime: AgentRuntime
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

function calculatePriceBounds(
  sqrtPrice: bigint,
  decimalsA: number,
  decimalsB: number,
  positionWidthBps: number
): NewPriceBounds {
  const currentPrice = sqrtPriceToPrice(sqrtPrice, decimalsA, decimalsB);
  const newLowerPrice = currentPrice * (1 - positionWidthBps / 10000);
  const newUpperPrice = currentPrice * (1 + positionWidthBps / 10000);

  return { newLowerPrice, newUpperPrice };
}

async function handleRepositioning(
  fetchedPositions: FetchedPosition[],
  repositionThresholdBps: number,
  rpc: Connection,
  wallet: KeyPairSigner
) {
  return await Promise.all(
    fetchedPositions.map(async (position) => {
      const { inRange, distanceCenterPositionFromPoolPriceBps } = position;
      if (!inRange || distanceCenterPositionFromPoolPriceBps > repositionThresholdBps) {
        const positionMintAddress = address(position.positionMint);
        const positionAddress = (await getPositionAddress(positionMintAddress))[0];
        const positionData = await fetchPosition(rpc, positionAddress);
        const whirlpoolAddress = positionData.data.whirlpool;
        let whirlpool = await fetchWhirlpool(rpc, whirlpoolAddress);
        const mintA = await getMint(rpc, whirlpool.data.tokenMintA);
        const mintB = await getMint(rpc, whirlpool.data.tokenMintB);
        const newPriceBounds: NewPriceBounds = calculatePriceBounds(
          whirlpool.data.sqrtPrice,
          mintA.decimals,
          mintB.decimals,
          position.positionWidthBps
        );
        let newLowerPrice = newPriceBounds.newLowerPrice;
        let newUpperPrice = newPriceBounds.newUpperPrice;

        elizaLogger.log(`Repositioning position: ${positionMintAddress}`);

        let closeSuccess = false;
        let closeTxId: string | undefined;
        while (!closeSuccess) {
          try {
            const { instructions: closeInstructions, quote } = await closePositionInstructions(
              rpc,
              positionMintAddress
            );
            closeTxId = await sendTransaction(rpc, closeInstructions, wallet);
            closeSuccess = !!closeTxId;

            // Prepare for open position
            const increaseLiquidityQuoteParam: IncreaseLiquidityQuoteParam = {
              liquidity: quote.liquidityDelta,
            };
            whirlpool = await fetchWhirlpool(rpc, whirlpoolAddress);
            const newPriceBounds: NewPriceBounds = calculatePriceBounds(
              whirlpool.data.sqrtPrice,
              mintA.decimals,
              mintB.decimals,
              position.positionWidthBps
            );
            newLowerPrice = newPriceBounds.newLowerPrice;
            newUpperPrice = newPriceBounds.newUpperPrice;
            let openSuccess = false;
            let openTxId: string | undefined;
            while (!openSuccess) {
              try {
                const { instructions: openInstructions, positionMint: newPositionMint } =
                  await openPositionInstructions(
                    rpc,
                    whirlpoolAddress,
                    increaseLiquidityQuoteParam,
                    newLowerPrice,
                    newUpperPrice
                  );
                openTxId = await sendTransaction(rpc, openInstructions, wallet);
                openSuccess = !!openTxId;

                elizaLogger.log(`Successfully reopened position with mint: ${newPositionMint}`);
                return { positionMintAddress, closeTxId, openTxId };
              } catch (openError) {
                elizaLogger.warn(
                  `Open position failed for ${positionMintAddress}, retrying. Error: ${openError}`
                );
                whirlpool = await fetchWhirlpool(rpc, whirlpoolAddress);
                const newPriceBounds: NewPriceBounds = calculatePriceBounds(
                  whirlpool.data.sqrtPrice,
                  mintA.decimals,
                  mintB.decimals,
                  position.positionWidthBps
                );
                newLowerPrice = newPriceBounds.newLowerPrice;
                newUpperPrice = newPriceBounds.newUpperPrice;
              }
            }
          } catch (closeError) {
            elizaLogger.warn(
              `Close position failed for ${positionMintAddress}, retrying after fetching new prices. Error: ${closeError}`
            );
            whirlpool = await fetchWhirlpool(rpc, whirlpoolAddress);
            const newPriceBounds: NewPriceBounds = calculatePriceBounds(
              whirlpool.data.sqrtPrice,
              mintA.decimals,
              mintB.decimals,
              position.positionWidthBps
            );
            newLowerPrice = newPriceBounds.newLowerPrice;
            newUpperPrice = newPriceBounds.newUpperPrice;
          }
        }
      } else {
        elizaLogger.log(`Position ${address(position.positionMint)} is in range, skipping.`);
        return null;
      }
    })
  );
}

const createSolanaRpc = (url: string) => new SolanaRpc(url);

const address = (addressString: string) => new PublicKey(addressString);
