import {
  type Action,
  type ActionExample,
  type ActionResult,
  composePromptFromState,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  parseJSONObjectFromText,
  type State,
  withStandaloneTrajectory,
} from "@elizaos/core";
import { runIntentModel } from "../../../utils/intent-trajectory";
import { SOLANA_SERVICE_NAME } from "../constants";
import { requireActionSpec } from "../generated/specs/spec-helpers";
import type { SolanaService, SolanaSwapParams, SolanaSwapResult } from "../service";
import type { Item } from "../types";
import { confirmationRequired, isConfirmed } from "./confirmation";

const SOLANA_SWAP_TIMEOUT_MS = 30_000;
const WALLET_TOKEN_LOOKUP_LIMIT = 100;

async function getTokenFromWallet(
  runtime: IAgentRuntime,
  tokenSymbol: string
): Promise<string | null> {
  try {
    const solanaService = runtime.getService(SOLANA_SERVICE_NAME) as SolanaService;
    if (!solanaService) {
      throw new Error("SolanaService not initialized");
    }

    const walletData = await solanaService.getCachedData();
    if (!walletData) {
      return null;
    }

    const token = walletData.items.slice(0, WALLET_TOKEN_LOOKUP_LIMIT).find(
      (item: Item) => item.symbol.toLowerCase() === tokenSymbol.toLowerCase()
    );

    return token ? token.address : null;
  } catch (error) {
    logger.error({ error }, "Error checking token in wallet");
    return null;
  }
}

import { swapTemplate } from "../generated/prompts/typescript/prompts.js";

const spec = requireActionSpec("SWAP");

type ExtractedSwapParams = {
  inputTokenSymbol?: string | null;
  outputTokenSymbol?: string | null;
  inputTokenCA?: string | null;
  outputTokenCA?: string | null;
  amount?: string | number | null;
};

async function extractSwapParams(
  runtime: IAgentRuntime,
  prompt: string
): Promise<ExtractedSwapParams> {
  const result = await withStandaloneTrajectory(
    runtime,
    {
      source: "solana.swap.extract",
      metadata: {
        action: spec.name,
        purpose: "financial_parameter_extraction",
      },
    },
    () =>
      runIntentModel({
        runtime,
        taskName: "solana.swap.intent",
        template: prompt,
        modelType: ModelType.TEXT_LARGE,
      })
  );

  return parseJSONObjectFromText(result) as ExtractedSwapParams;
}

function toAmount(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || String(value).toLowerCase() === "null") {
    return null;
  }
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

function normalizeTokenValue(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = String(value).trim();
  if (trimmed === "" || trimmed.toLowerCase() === "null") return null;
  return trimmed;
}

export const executeSwap: Action = {
  name: spec.name,
  similes: spec.similes ? [...spec.similes] : [],
  contexts: ["finance", "crypto", "wallet"],
  contextGate: { anyOf: ["finance", "crypto", "wallet"] },
  roleGate: { minRole: "USER" },
  parameters: [
    {
      name: "fromToken",
      description: "Input token symbol, mint address, or SOL.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "toToken",
      description: "Output token symbol, mint address, or SOL.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "amount",
      description: "Human-readable amount to swap.",
      required: true,
      schema: { type: "string" },
    },
    {
      name: "slippageBps",
      description: "Maximum slippage in basis points.",
      required: false,
      schema: { type: "number" },
    },
    {
      name: "confirmed",
      description: "Set true after preview confirmation to submit.",
      required: false,
      schema: { type: "boolean", default: false },
    },
  ],
  validate: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: Record<string, unknown>
  ): Promise<boolean> => {
    const text = message.content?.text?.toLowerCase() ?? "";
    if (!/\bswap\b/i.test(text)) {
      return false;
    }
    return Boolean(runtime.getService(SOLANA_SERVICE_NAME));
  },
  description: spec.description,
  descriptionCompressed: spec.descriptionCompressed,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state?: State,
    options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<ActionResult | undefined> => {
    state = await runtime.composeState(message, ["RECENT_MESSAGES"]);

    try {
      const solanaService = runtime.getService(SOLANA_SERVICE_NAME) as SolanaService;
      if (!solanaService) {
        throw new Error("SolanaService not initialized");
      }

      const walletData = await solanaService.getCachedData();
      state.values.walletInfo = walletData;

      const swapPrompt = composePromptFromState({
        state,
        template: swapTemplate,
      });

      const response = await extractSwapParams(runtime, swapPrompt);
      response.inputTokenCA = normalizeTokenValue(response.inputTokenCA);
      response.outputTokenCA = normalizeTokenValue(response.outputTokenCA);
      response.inputTokenSymbol = normalizeTokenValue(response.inputTokenSymbol);
      response.outputTokenSymbol = normalizeTokenValue(response.outputTokenSymbol);

      if (response.inputTokenSymbol?.toUpperCase() === "SOL") {
        response.inputTokenCA = "SOL";
      }
      if (response.outputTokenSymbol?.toUpperCase() === "SOL") {
        response.outputTokenCA = "SOL";
      }
      if (!response.inputTokenCA && response.inputTokenSymbol) {
        response.inputTokenCA =
          (await getTokenFromWallet(runtime, response.inputTokenSymbol)) || "";
        if (!response.inputTokenCA) {
          callback?.({ text: "Could not find the input token in your wallet" });
          return;
        }
      }

      if (!response.outputTokenCA && response.outputTokenSymbol) {
        response.outputTokenCA =
          (await getTokenFromWallet(runtime, response.outputTokenSymbol)) || "";
        if (!response.outputTokenCA) {
          callback?.({
            text: "Could not find the output token in your wallet",
          });
          return;
        }
      }

      const amount = toAmount(response.amount);
      if (!amount) {
        callback?.({ text: "Please specify the amount you want to swap" });
        return;
      }

      const swapParams: SolanaSwapParams = {
        inputTokenSymbol: response.inputTokenSymbol,
        outputTokenSymbol: response.outputTokenSymbol,
        inputTokenCA: response.inputTokenCA,
        outputTokenCA: response.outputTokenCA,
        amount,
      };

      if (!isConfirmed(options)) {
        const preview = `Review Solana swap before submitting: ${amount} ${response.inputTokenCA ?? response.inputTokenSymbol ?? "input token"} to ${response.outputTokenCA ?? response.outputTokenSymbol ?? "output token"}. Re-invoke ${spec.name} with confirmed: true to submit.`;
        return confirmationRequired({
          actionName: spec.name,
          preview,
          parameters: {
            inputTokenSymbol: response.inputTokenSymbol ?? null,
            outputTokenSymbol: response.outputTokenSymbol ?? null,
            inputTokenCA: response.inputTokenCA ?? null,
            outputTokenCA: response.outputTokenCA ?? null,
            amount,
          },
          callback,
        });
      }

      const swapResult = (await Promise.race([
        solanaService.handleWalletAction({
          subaction: "swap",
          chain: "solana",
          ...swapParams,
          mode: options?.dryRun === true ? "prepare" : "execute",
          dryRun: options?.dryRun === true,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Solana swap timeout")), SOLANA_SWAP_TIMEOUT_MS)
        ),
      ])) as SolanaSwapResult;

      callback?.({
        text: swapResult.dryRun
          ? "Solana swap dry run completed."
          : `Swap completed successfully! Transaction ID: ${swapResult.txid}`,
        content: { success: true, txid: swapResult.txid, dryRun: swapResult.dryRun },
      });

      return;
    } catch (error) {
      if (error instanceof Error) {
        logger.error({ error }, "Error during token swap");
        callback?.({
          text: `Swap failed: ${error.message}`,
          content: { error: error.message },
        });
        return;
      }
      throw error;
    }
  },
  examples: (spec.examples ?? []) as ActionExample[][],
};
