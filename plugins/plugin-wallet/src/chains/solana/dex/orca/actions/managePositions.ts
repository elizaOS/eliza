// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import {
  type ActionResult,
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
  contexts: ["finance", "crypto", "wallet"],
  contextGate: { anyOf: ["finance", "crypto", "wallet"] },
  roleGate: { minRole: "USER" },
  similes: ["AUTOMATE_REBALANCING", "AUTOMATE_POSITIONS", "START_MANAGING_POSITIONS"],
  description:
    "Automatically manage positions by rebalancing them when they drift too far from the pool price",
  descriptionCompressed: "automatically manage position rebalance drift too far pool price",
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

  validate: async (runtime: AgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    if (selectedContextMatches(state, ["finance", "crypto", "wallet"])) {
      return true;
    }
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
    runtime: AgentRuntime,
    message: Memory,
    state: State,
    params: { [key: string]: unknown },
    _callback?: HandlerCallback
  ): Promise<ActionResult> => {
    elizaLogger.log("Start managing positions");
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
          "Missing or invalid Orca position-management config. Provide repositionThresholdBps, intervalSeconds, and slippageToleranceBps.",
          { providedParams: Object.keys(params ?? {}) },
          "INVALID_MANAGE_POSITIONS_CONFIG"
        );
      }
      const { repositionThresholdBps, intervalSeconds, slippageToleranceBps } = config;
      const fetchedPositions = extractOrcaPositionsFromState(state);
      elizaLogger.log(
        `Validated configuration: repositionThresholdBps=${repositionThresholdBps}, slippageTolerance=${slippageToleranceBps}`
      );
      const { signer: wallet } = await loadWallet(runtime, true);
      const solanaRpcUrl = settings.SOLANA_RPC_URL;
      if (!solanaRpcUrl) {
        return buildActionResult(
          false,
          "SOLANA_RPC_URL setting is required to manage Orca positions.",
          undefined,
          "SOLANA_RPC_URL setting is required to manage Orca positions."
        );
      }
      const rpc = createSolanaRpc(solanaRpcUrl);
      setDefaultSlippageToleranceBps(slippageToleranceBps);
      setDefaultFunder(wallet);

      const results = await handleRepositioning(
        fetchedPositions,
        repositionThresholdBps,
        rpc,
        wallet
      );
      const changed = results.filter((item): item is NonNullable<(typeof results)[number]> =>
        Boolean(item)
      );
      const unchangedCount = fetchedPositions.length - changed.length;
      return buildActionResult(
        true,
        changed.length > 0
          ? `Managed ${fetchedPositions.length} Orca positions; rebalanced ${changed.length} and skipped ${unchangedCount}.`
          : `Checked ${fetchedPositions.length} Orca positions; all remained in range.`,
        {
          config: { repositionThresholdBps, intervalSeconds, slippageToleranceBps },
          totalPositions: fetchedPositions.length,
          rebalancedCount: changed.length,
          skippedCount: unchangedCount,
          rebalancedPositions: changed.slice(0, REBALANCE_SUMMARY_LIMIT).map((item) => ({
            positionMint: item.positionMintAddress,
            closeTxId: item.closeTxId,
            openTxId: item.openTxId,
          })),
        }
      );
    } catch (error) {
      const errorMessage = toActionError(error);
      return buildActionResult(
        false,
        `Failed to manage Orca positions: ${errorMessage}`,
        { providedParams: Object.keys(params ?? {}) },
        errorMessage
      );
    }
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
