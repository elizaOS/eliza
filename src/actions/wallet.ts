import { isHex } from "viem";
import { Action, logger, ModelType } from "@elizaos/core";
import { LEVVA_ACTIONS, LEVVA_SERVICE } from "../constants/enum";
import { IGNORE_REPLY_MODIFIER } from "../constants/prompt";
import { selectLevvaState } from "../providers";
import type { LevvaService } from "../services/levva/class";
import { getChain } from "../util/eth/client";
import { rephrase } from "../util/generate";
import { Suggestion } from "./types";

export const action: Action = {
  name: LEVVA_ACTIONS.ANALYZE_WALLET,
  description: `Replies with wallet stats. ${IGNORE_REPLY_MODIFIER}.`,
  similes: ["ANALYZE_WALLET", "analyze wallet"],

  validate: async () => {
    return true;
  },

  handler: async (runtime, message, state, options, callback) => {
    // todo refactor action that it can be chained properly: [REPLY, ANALYZE_WALLET], not just [ANALYZE_WALLET]
    try {
      const service = runtime.getService<LevvaService>(
        LEVVA_SERVICE.LEVVA_COMMON
      );

      if (!service) {
        throw new Error("Failed to get levva service, disable action");
      }

      if (!state) {
        throw new Error("State not found, disable action");
      }

      if (!callback) {
        throw new Error("Callback not found, disable action");
      }

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

      const [assets, news, strategies] = await Promise.all([
        service.getWalletAssets({ chainId, address }),
        service.getCryptoNews(),
        service.getStrategies(chainId),
      ]);

      const result = await runtime.useModel(ModelType.OBJECT_LARGE, {
        prompt: `<task>Analyze user's portfolio and provide a summary.</task>
<portfolio>
User has following tokens available in portfolio:
${service.formatWalletAssets(assets)}
</portfolio>
<strategies>
Strategies:
${strategies.map(service.formatStrategy).join("\n")}
</strategies>
<news>
Latest news:
${news.map((v) => v.description).join("\n")}
</news>
<instructions>
Ignore zero balances
Display summary of user's holdings.
Gain insights from the news and portfolio.
Look at available strategies and suggest actions.
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

      return;
    } catch (error) {
      logger.error("Error in SWAP_TOKENS action:", error);
      // @ts-expect-error fix typing
      const thought = `Action failed with error: ${error.message ?? "unknown"}. I should tell the user about the error.`;
      // @ts-expect-error fix typing
      const text = `Failed to swap, reason: ${error.message ?? "unknown"}. Please try again.`;

      const responseContent = await rephrase({
        runtime,
        content: {
          text,
          thought,
          actions: ["ANALYZE_WALLET"],
          source: message.content.source,
        },
        state: state!,
      });

      await callback?.(responseContent);
      return;
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

export const suggest: Suggestion[] = [];