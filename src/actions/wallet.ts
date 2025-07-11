import { Action, logger, ModelType } from "@elizaos/core";
import { LEVVA_ACTIONS, LEVVA_SERVICE } from "../constants/enum";
import { ILevvaService } from "../types/service";
import { IGNORE_REPLY_MODIFIER } from "src/constants/prompt";
import { selectLevvaState } from "src/providers";
import { getChain } from "src/util/eth/client";
import { isHex } from "viem";
import { rephrase } from "src/util/generate";

export const analyzeWallet: Action = {
  name: LEVVA_ACTIONS.ANALYZE_WALLET,
  description: `Replies with wallet stats. ${IGNORE_REPLY_MODIFIER}.`,
  similes: ["ANALYZE_WALLET", "analyze wallet"],

  validate: async () => {
    return true;
  },

  handler: async (runtime, message, state, options, callback) => {
    try {
      const service = runtime.getService<ILevvaService>(
        LEVVA_SERVICE.LEVVA_COMMON
      );
      const levvaState = selectLevvaState(state);

      if (!levvaState?.user) {
        throw new Error("User address ID is required");
      }

      const { chainId, user } = levvaState;
      // todo maybe move chains to db?
      const chain = getChain(chainId);
      const { address } = user;

      if (!isHex(address)) {
        throw new Error("User not found");
      }

      const [assets, news, pendleMarkets] = await Promise.all([
        service.getWalletAssets({ chainId, address }),
        service.getCryptoNews(),
        service.getPendleMarkets({ chainId }),
      ]);

      const result = await runtime.useModel(ModelType.OBJECT_LARGE, {
        prompt: `<task>Analyze user's portfolio and provide a summary.</task>
<portfolio>
User has following tokens available in portfolio:
${service.formatWalletAssets(assets)}
</portfolio>
<markets>
Pendle markets:
${pendleMarkets.map((v) => `${v.name} - Expiration: ${v.expiry}; Details: ${JSON.stringify(v.details)}`).join("\n")}
</markets>
<news>
Latest news:
${news.map((v) => v.description).join("\n")}
</news>
<instructions>
Display summary of user's holdings.
Gain insights from the news and portfolio.
Look at available markets and suggest actions.
</instructions>
<output>
Respond using JSON format like this:
{
  "thought": "<string>",
  "text": "<string>"
}

Your response should include the valid JSON block and nothing else.
</output>`,
      });

      await callback({
        text: result.text,
        thought: result.thought,
        actions: ["ANALYZE_WALLET"],
        source: message.content.source,
      });

      return true;
    } catch (error) {
      logger.error("Error in SWAP_TOKENS action:", error);
      const thought = `Action failed with error: ${error.message ?? "unknown"}. I should tell the user about the error.`;
      const text = `Failed to swap, reason: ${error.message ?? "unknown"}. Please try again.`;

      const responseContent = await rephrase({
        runtime,
        content: {
          text,
          thought,
          actions: ["ANALYZE_WALLET"],
          source: message.content.source,
        },
        state,
      });

      await callback(responseContent);
      return false;
    }
  },

  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Please analyze my wallet",
        },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "Your portfolio value is worth {{total}}. Your tokens are {{tokens}}",
          action: "ANALYZE_WALLET",
        },
      },
    ],
  ],
};
