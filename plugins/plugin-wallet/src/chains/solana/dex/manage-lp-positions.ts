// @ts-nocheck — legacy code from absorbed plugins (lp-manager, orca, raydium); strict types pending cleanup
import {
  type Action,
  elizaLogger,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  ModelType,
  parseJSONObjectFromText,
  type State,
} from "@elizaos/core";
import { runIntentModel } from "../../../utils/intent-trajectory";
import { managePositions as orcaManagePositions } from "./orca/actions/managePositions";
import { managePositions as raydiumManagePositions } from "./raydium/actions/managePositions";

export type ManageLpPositionsDex = "orca" | "raydium";

export interface ManageLpPositionsParams {
  readonly dex: ManageLpPositionsDex;
  readonly repositionThresholdBps?: number;
  readonly slippageToleranceBps?: number;
  readonly intervalSeconds?: number;
}

interface ExtractedConfig {
  repositionThresholdBps: number | null;
  intervalSeconds: number | null;
  slippageToleranceBps: number | null;
}

function readInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === "null") return null;
  const parsed = Number(trimmed);
  return Number.isInteger(parsed) ? parsed : null;
}

/**
 * Extract reposition configuration from a free-form user message via the
 * canonical intent-trajectory helper so the LLM call is recorded on the
 * active trajectory.
 */
export async function extractManageLpConfig(
  runtime: IAgentRuntime,
  text: string
): Promise<ExtractedConfig | null> {
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
  const response = await runIntentModel({
    runtime,
    taskName: "solana.lp.manage.intent",
    template: prompt,
    modelType: ModelType.TEXT_SMALL,
  });

  try {
    const cfg = parseJSONObjectFromText(response) as Record<string, unknown> | null;
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
      return null;
    }
    return {
      repositionThresholdBps: readInteger(cfg.repositionThresholdBps),
      intervalSeconds: readInteger(cfg.intervalSeconds),
      slippageToleranceBps: readInteger(cfg.slippageToleranceBps),
    };
  } catch (error) {
    elizaLogger.warn("Invalid LP manage configuration:", error);
    return null;
  }
}

function readDex(options: Record<string, unknown> | undefined): ManageLpPositionsDex {
  const dex = String(options?.dex ?? "").toLowerCase();
  if (dex === "orca" || dex === "raydium") {
    return dex;
  }
  throw new Error("Missing or invalid 'dex' parameter (expected 'orca' | 'raydium')");
}

export const manageLpPositionsAction: Action = {
  name: "MANAGE_LP_POSITIONS",
  similes: [
    "AUTOMATE_REBALANCING",
    "AUTOMATE_POSITIONS",
    "START_MANAGING_POSITIONS",
    "AUTOMATE_RAYDIUM_REBALANCING",
    "AUTOMATE_RAYDIUM_POSITIONS",
    "START_MANAGING_RAYDIUM_POSITIONS",
    "manage_positions",
    "manage_raydium_positions",
  ],
  description:
    "Automatically rebalance Solana CLMM LP positions when they drift too far from the pool price. Supports Orca Whirlpools and Raydium CLMM via { dex: 'orca' | 'raydium' }.",
  descriptionCompressed: "Solana LP rebalance: orca or raydium CLMM (dex switch).",
  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    const text =
      typeof message?.content?.text === "string" ? message.content.text.toLowerCase() : "";
    const keywords = ["manage", "position", "rebalance", "liquidity", "orca", "raydium"];
    const keywordOk = keywords.some((kw) => text.includes(kw));
    const regexOk = /\b(?:manage|position|positions|rebalance|liquidity|orca|raydium)\b/i.test(
      text
    );
    if (!(keywordOk && regexOk)) return false;
    return Boolean(message.content || state || runtime.agentId);
  },
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State,
    options: Record<string, unknown> | undefined,
    callback?: HandlerCallback
  ) => {
    const dex = readDex(options);
    const handler = dex === "orca" ? orcaManagePositions.handler : raydiumManagePositions.handler;
    return handler(runtime, message, state, options ?? {}, callback);
  },
  examples: [
    [
      {
        name: "{{userName}}",
        content: {
          text: "Start managing my Orca positions and rebalance when drift exceeds 100 bps",
          action: "MANAGE_LP_POSITIONS",
        },
      },
    ],
    [
      {
        name: "{{userName}}",
        content: {
          text: "Automatically rebalance my Raydium LP positions with 0.5% slippage",
          action: "MANAGE_LP_POSITIONS",
        },
      },
    ],
  ],
};
