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
  contexts: ["finance", "crypto", "wallet", "automation"],
  contextGate: { anyOf: ["finance", "crypto", "wallet", "automation"] },
  roleGate: { minRole: "USER" },
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
  parameters: [
    {
      name: "dex",
      description: "Which Solana CLMM to manage: orca or raydium.",
      required: true,
      schema: { type: "string", enum: ["orca", "raydium"] },
    },
    {
      name: "repositionThresholdBps",
      description: "Optional drift threshold in basis points before rebalancing.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "slippageToleranceBps",
      description: "Optional slippage tolerance in basis points for rebalance transactions.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "intervalSeconds",
      description: "Optional interval, in seconds, between management checks.",
      required: false,
      schema: { type: "number" },
    },
  ],
  validate: async (runtime: IAgentRuntime, message: Memory, state?: State): Promise<boolean> => {
    if (selectedContextMatches(state, ["finance", "crypto", "wallet", "automation"])) {
      return true;
    }
    const text =
      typeof message?.content?.text === "string" ? message.content.text.toLowerCase() : "";
    const keywords = [
      "manage",
      "position",
      "rebalance",
      "liquidity",
      "orca",
      "raydium",
      "lp",
      "pool",
      "liquidez",
      "posición",
      "rebalancear",
      "liquidité",
      "rééquilibrer",
      "liquidität",
      "流動性",
      "再調整",
      "流动性",
      "再平衡",
      "유동성",
      "리밸런싱",
    ];
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
