import {
  type Action,
  type Content,
  logger,
  ModelType,
} from "@elizaos/core";
import { erc20Abi, isHex, parseUnits } from "viem";
import { LEVVA_ACTIONS, LEVVA_SERVICE } from "../constants/enum";
import { IGNORE_REPLY_MODIFIER } from "../constants/prompt";
import { selectLevvaState } from "../providers";
import { LevvaService } from "../services/levva/class";
import { estimationTemplate, swapTemplate } from "../templates";
import {
  getChain,
  getClient,
} from "../util";
import { rephrase } from "../util/generate";
import { formatEstimation, selectSwapRouter } from "../util/eth/swap";
import { Suggestion } from "./types";
import { selectSwapDataFromMessagesPrompt } from "src/prompts/swap";

const description = [
  "Initiate token swap for user.",
  "Ask user for exchange pair and amount if not provided.",
  "If all the info is provided, this action should respond with swap details and transaction calldata.",
  IGNORE_REPLY_MODIFIER,
].join(" ");

export const action: Action = {
  name: LEVVA_ACTIONS.SWAP_TOKENS,
  description,
  similes: ["SWAP_TOKENS", "EXCHANGE_TOKENS", "swap tokens", "exchange tokens"],

  validate: async () => {
    return true;
  },

  handler: async (runtime, message, state, options, callback) => {
    try {
      logger.info("SWAP_TOKENS action called");
      const service = runtime.getService<LevvaService>(
        LEVVA_SERVICE.LEVVA_COMMON
      );

      if (!service) {
        throw new Error("Failed to get levva service, disable action");
      }

      if (!callback) {
        throw new Error("Callback not found, disable action");
      }

      if (!state) {
        throw new Error("State not found, disable action");
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

      const gen = await runtime.useModel(
        // fixme use ModelType.OBJECT_SMALL with grok
        ModelType.OBJECT_LARGE,
        {
          prompt: selectSwapDataFromMessagesPrompt({
            recentMessages: state.values.recentMessages,
            tokens: state.values.tokens,
          }),
        }
      );

      if (typeof gen !== "object") {
        throw new Error("Failed to generate params object");
      }

      const { fromToken, toToken, amount } = gen;

      if (!fromToken) {
        logger.info("Could not find from token, need to ask user");

        const responseContent: Content = {
          thought:
            "User didn't provide source token, I should ask the user for it.",
          text: "Which token do you want to swap?",
          actions: ["SWAP_TOKENS"],
          source: message.content.source,
        };

        await callback(
          await rephrase({ runtime, content: responseContent, state })
        );

        return;
      } else if (!toToken) {
        logger.info("Could not find to token, need to ask user");

        const responseContent: Content = {
          thought:
            "User didn't provide destination token, I should ask the user for it.",
          text: "Which token do you want to swap to?",
          actions: ["SWAP_TOKENS"],
          source: message.content.source,
        };

        await callback(
          await rephrase({ runtime, content: responseContent, state })
        );

        return;
      } else if (!amount) {
        logger.info("Could not find amount, need to ask user");

        const responseContent = {
          thought: "User didn't provide amount, I should ask the user for it.",
          text: `How much ${fromToken} do you want to swap?`,
          actions: ["SWAP_TOKENS"],
          source: message.content.source,
        };

        await callback(
          await rephrase({ runtime, content: responseContent, state })
        );

        return;
      }

      const tokenIn = await service.getTokenDataWithInfo({
        chainId,
        symbolOrAddress: fromToken,
      });

      if (!tokenIn) {
        logger.info(
          "Could not find token in db, need to ask user for its address"
        );

        const responseContent: Content = {
          thought:
            "User didn't provide token in address, I should ask the user for it.",
          text: `I couldn't find the token ${fromToken} on ${chain.name}, maybe you know it's address?`,
          actions: ["SWAP_TOKENS"],
          source: message.content.source,
        };

        await callback(
          await rephrase({ runtime, content: responseContent, state })
        );

        return;
      }

      const tokenOut = await service.getTokenDataWithInfo({
        chainId,
        symbolOrAddress: toToken,
      });

      if (!tokenOut) {
        logger.info(
          "Could not find token out, need to ask user for its address"
        );

        const responseContent: Content = {
          thought:
            "User didn't provide token out address, I should ask the user for it.",
          text: `I couldn't find the token ${toToken} on ${chain.name}, maybe you know it's address?`,
          actions: ["SWAP_TOKENS"],
          source: message.content.source,
        };

        await callback(
          await rephrase({ runtime, content: responseContent, state })
        );

        return;
      }

      const client = getClient(chain);

      const balance = !tokenIn.address
        ? await client.getBalance({ address })
        : await client.readContract({
            address: tokenIn.address,
            abi: erc20Abi,
            functionName: "balanceOf",
            args: [address],
          });

      const amountUnits = parseUnits(amount, tokenIn.decimals);

      if (balance < amountUnits) {
        logger.info(`Not enough ${tokenIn.symbol} to swap`);

        const responseContent: Content = {
          thought:
            "User doesn't have enough tokens to swap, I should tell the user about it.",
          text: `You don't have enough ${tokenIn.symbol} to swap`,
          actions: ["SWAP_TOKENS"],
          source: message.content.source,
        };

        await callback(
          await rephrase({ runtime, content: responseContent, state })
        );

        return;
      }

      const swap = selectSwapRouter(tokenIn, tokenOut);

      const { calls, estimation } = await swap(runtime, {
        address,
        amountIn: amountUnits,
        chain,
        decimals: tokenIn.decimals,
      });

      const hash = await service.createCalldata(calls);

      const json = {
        id: "calls.json",
        url: `/api/calldata?hash=${hash}`,
      };

      const responseContent: Content = {
        thought: `Swapping ${amount} ${tokenIn.symbol} to ${tokenOut.symbol}...`,
        text: `Swapping ${amount} ${tokenIn.symbol} to ${tokenOut.symbol}...
${formatEstimation(estimation)}
Please approve transactions in your wallet.`,
        actions: ["SWAP_TOKENS"],
        source: message.content.source,
        attachments: [json],
      };

      await callback(
        await rephrase({ runtime, content: responseContent, state })
      );

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
          actions: ["SWAP_TOKENS"],
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
          text: "Please swap {{amount}} {{token1}} to {{token2}}",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Please confirm swap for {{amount}} {{token1}} for {{token2}}",
          action: "SWAP_TOKENS",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Swap tokens",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Which token do you want to swap?",
          action: "SWAP_TOKENS",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "I want to swap {{token1}} to {{token2}}",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Excuse me, I couldn't find the token {{token1}}, if you know could you provide me with it's address?",
          action: "SWAP_TOKENS",
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "{{amount}} {{token1}} to {{token2}}",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: `Swapping {{amount}} {{token1}} to {{token2}}...\n${estimationTemplate(true)}\nPlease approve transactions in your wallet.`,
          action: "SWAP_TOKENS",
          attachments: [
            {
              id: "calls.json",
              url: "data:application/json;base64,{{calls}}",
            },
          ],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Token address is {{address}}",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Swapping {{amount}} {{token1}} to {{token2}}...\nPlease approve transactions in your wallet.",
          actions: ["SWAP_TOKENS"],
        },
      },
    ],
    [
      // fixme maybe needs another action type for this
      {
        name: "{{name1}}",
        content: {
          text: "Cancel transaction",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Your transaction request has been cancelled.",
          actions: ["SWAP_TOKENS"],
        },
      },
    ],
  ],
};

export const suggest: Suggestion[] = [
  {
    name: "exchange-amount",
    description:
      "Use if user wants to swap tokens, and the agent knows what token to swap but the amount is not specified, suggest how much to swap based on user's portfolio, eg: known includes 'tokenIn' and 'tokenOut' and unknown includes 'amountIn'",
    getPrompt: async (
      runtime,
      { address, chainId, conversation, decision }
    ) => {
      const service = runtime.getService<LevvaService>(
        LEVVA_SERVICE.LEVVA_COMMON
      );

      if (!service) {
        throw new Error("Failed to get levva service");
      }

      const assets = await service.getWalletAssets({ address, chainId });
      const available = await service.getAvailableTokens({ chainId });

      return `<task>Generate suggestions for exchange amount or alternative swap pairs, given user's portfolio and previous conversation
</task>
<decision>
${JSON.stringify(decision)}
</decision>
<portfolio>
User has following tokens available in portfolio:
${service.formatWalletAssets(assets)}
</portfolio>
<availableTokens>
Tokens known to agent:
${available.map((token) => `${token.symbol} - ${token.address ?? "Native token"}`).join(", ")}
</availableTokens>
<conversation>
${conversation}
</conversation>
<instructions>
User can either have the input token available or not, so consider cases:

1. When input token NOT in portfolio:
  - Generate 4 suggestions for another input token available in portfolio without token amount.
  - Input token should NOT be the same as the output token, so "Swap ETH -> USDT" is CORRECT, but "Swap ETH -> ETH" is WRONG.
  - Acknowledge missing input token in label, eg. "No {{tokenIn}}, swap {{availableToken}} -> {{tokenOut}}".
  - Text should NOT include amount, eg. "I want to swap {{availableToken}} to {{tokenOut}}" is CORRECT, but "I want to swap 0.123456789987654321 {{availableToken}} to {{tokenOut}}" is WRONG.

2. When input token IS in portfolio:
  - Generate 4 suggestions for exchange amount, that corresponds to 100%(or 95% instead for native token or deduced value if present), 50%, 25%, 10% of the input token balance.
  - User should be able to see trimmed swap amount in suggestion label, but not the percentage, eg. NOT "100% {{tokenIn}}", but "0.12 {{tokenIn}}".
  - Trim amount in label to 6 decimal places if the value is less than 1. Use 2 decimal places otherwise, eg. "0.12 {{tokenIn}}".
  - Do not trim amount in text, eg. "I want to swap 0.123456789987654321 {{tokenIn}}".

Determine if user has input token available in portfolio and use appropriate case.
</instructions>
<keys>
- "thought" should be a short description of what the agent is thinking about and planning.
- "suggestions" should be an array of objects with the following keys:
  - "label" - short description of the suggestion
  - "text" - message containing untrimmed swap amount 
</keys>
<output>
Respond using JSON format like this:
{
  "thought": "<string>",
  "suggestions": <array>
}

Your response should include the valid JSON block and nothing else.
</output>`;
    },
  },
  {
    name: "exchange-pairs",
    description:
      "Use if the user wants to swap tokens, and the agent does not know which ones, suggest preferred exchange pairs, eg. unknown includes 'tokenIn' and 'tokenOut'; also choose this suggestion if an agent does not recognize the token",
    getPrompt: async (
      runtime,
      { address, chainId, conversation, decision }
    ) => {
      const service = runtime.getService<LevvaService>(
        LEVVA_SERVICE.LEVVA_COMMON
      );

      if (!service) {
        throw new Error("Failed to get levva service");
      }

      const assets = await service.getWalletAssets({ address, chainId });
      const available = await service.getAvailableTokens({ chainId });

      return `<task>
Generate suggestions for exchange pairs, given user's portfolio and available tokens
</task>
<decision>
${JSON.stringify(decision)}
</decision>
<conversation>
${conversation}
</conversation>
<portfolio>
User has following tokens available in portfolio:
${service.formatWalletAssets(assets)}
</portfolio>
<availableTokens>
Tokens known to agent:
${available.map((token) => `${token.symbol} - ${token.address ?? "Native token"}`).join(", ")}
</availableTokens>
<instructions>
Generate 5 suggestions for exchange pairs
Please include exact token symbol for suggestion text.
</instructions>
<keys>
- "suggestions" should be an array of objects with the following keys:
  - "label"
  - "text"
</keys>
<output>
Respond using JSON format like this:
{
  "suggestions": [
    {
      "label": "USDT -> ETH",
      "text": "I want to swap USDT to ETH",
    },
    {
      "label": "ETH -> USDT",
      "text": "Please, exchange ETH to USDT",
    },
    {
      "label": "ETH -> USDC",
      "text": "ETH for USDC",
    }
  ]
}

Your response should include the valid JSON block and nothing else.
</output>`;
    },
  },
];
