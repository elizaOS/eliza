import {
  type Action,
  type Content,
  type HandlerCallback,
  type IAgentRuntime,
  logger,
  type Memory,
  type State,
} from "@elizaos/core";
import type { ClobClient } from "@polymarket/clob-client";
import { getMidpointPriceTemplate } from "../templates";
import { initializeClobClient } from "../utils/clobClient";
import { callLLMWithTimeout, isLLMError } from "../utils/llmHelpers";

interface LLMMidpointResult {
  tokenId?: string;
  error?: string;
}

interface MidpointResult {
  mid: string;
}

/**
 * Get Midpoint Price Action for Polymarket.
 * Returns the midpoint price (average of best bid and best ask) for a given token.
 */
export const getMidpointPriceAction: Action = {
  name: "POLYMARKET_GET_MIDPOINT_PRICE",
  similes: ["GET_MID_PRICE", "MIDPOINT", "MID_MARKET", "FAIR_VALUE_PRICE"].map(
    (s) => `POLYMARKET_${s}`
  ),
  description:
    "Gets the midpoint price (average of best bid and best ask) for a specified token ID on Polymarket.",

  validate: async (runtime: IAgentRuntime, message: Memory, _state?: State): Promise<boolean> => {
    logger.info(`[getMidpointPriceAction] Validate called for message: "${message.content?.text}"`);
    const clobApiUrl = runtime.getSetting("CLOB_API_URL");

    if (!clobApiUrl) {
      logger.warn("[getMidpointPriceAction] CLOB_API_URL is required.");
      return false;
    }
    logger.info("[getMidpointPriceAction] Validation passed");
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    _message: Memory,
    state?: State,
    _options?: Record<string, unknown>,
    callback?: HandlerCallback
  ): Promise<Content> => {
    logger.info("[getMidpointPriceAction] Handler called!");

    const result = await callLLMWithTimeout<LLMMidpointResult>(
      runtime,
      state,
      getMidpointPriceTemplate,
      "getMidpointPriceAction"
    );
    let llmResult: LLMMidpointResult = {};
    if (result && !isLLMError(result)) {
      llmResult = result;
    }
    logger.info(`[getMidpointPriceAction] LLM result: ${JSON.stringify(llmResult)}`);

    if (llmResult.error || !llmResult.tokenId) {
      throw new Error(llmResult.error || "Token ID not found in LLM result.");
    }

    const tokenId = llmResult.tokenId;

    logger.info(`[getMidpointPriceAction] Fetching midpoint price for token: ${tokenId}`);

    const client = (await initializeClobClient(runtime)) as ClobClient;
    const midpointResult: MidpointResult = await client.getMidpoint(tokenId);

    let responseText = `📈 **Midpoint Price for Token ${tokenId}**:\n\n`;
    if (midpointResult?.mid) {
      responseText += `• **Midpoint**: $${parseFloat(midpointResult.mid).toFixed(4)}\n`;
      responseText += `\n*The midpoint is the average of the best bid and best ask prices.*\n`;
    } else {
      responseText += `Could not retrieve midpoint price. Order book might be empty or have no quotes on both sides.\n`;
    }

    const responseContent: Content = {
      text: responseText,
      actions: ["GET_MIDPOINT_PRICE"],
      data: {
        tokenId,
        midpoint: midpointResult?.mid,
        timestamp: new Date().toISOString(),
      },
    };

    if (callback) await callback(responseContent);
    return responseContent;
  },

  examples: [
    [
      {
        name: "{{user1}}",
        content: {
          text: "What is the midpoint price for token xyz123 on Polymarket?",
        },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Fetching the midpoint price for token xyz123 on Polymarket...",
          action: "POLYMARKET_GET_MIDPOINT_PRICE",
        },
      },
    ],
    [
      {
        name: "{{user1}}",
        content: {
          text: "Get the mid-market price for token 0xabc789 via Polymarket.",
        },
      },
      {
        name: "{{user2}}",
        content: {
          text: "Looking up the midpoint price for token 0xabc789 on Polymarket...",
          action: "POLYMARKET_GET_MIDPOINT_PRICE",
        },
      },
    ],
  ],
};
