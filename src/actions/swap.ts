import { parseUnits } from "viem";
import { type Action, type Content, logger, Media } from "@elizaos/core";
import { LEVVA_ACTIONS, LEVVA_SERVICE } from "../constants/enum";
import { LEVVA_PROVIDER_NAME, LevvaProviderState } from "../providers";
import {
  SWAP_PARAMS_PROVIDER_NAME,
  SwapParamsProviderData,
} from "../providers/swap-params";
import { selectProviderState } from "../providers/util";
import { LevvaService } from "../services/levva/class";
import { estimationTemplate } from "../templates";
import { CalldataWithDescription } from "../types/tx";
import { getChain } from "../util";
import { rephrase } from "../util/generate";
import { formatEstimation, selectSwapRouter } from "../util/eth/swap";
import { Suggestion } from "./types";
import { unwrapEth, wrapEth } from "src/util/eth/weth";

const description = [
  "Initiate token swap for user if all parameters are provider or inquire user for swap parameters.",
].join(" ");

export const action: Action = {
  name: LEVVA_ACTIONS.SWAP_TOKENS,
  description,
  similes: ["SWAP_TOKENS", "EXCHANGE_TOKENS", "swap tokens", "exchange tokens"],

  validate: async () => {
    // fixme validations run in ACTIONS provider on 1st runtime.composeState call
    // runtime.composeState gets all providers in Promise.all, so provider position does not seem to matter
    // consider implementing composeState sequentially, or calling compose state in validator(seems unreliable)
    // so for now decide to always include
    return true;
  },

  handler: async (runtime, message, state, options, callback) => {
    // todo refactor action that it can be chained properly: [REPLY, SWAP_TOKENS], not just [SWAP_TOKENS]
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

      const lvva = selectProviderState<LevvaProviderState>(
        LEVVA_PROVIDER_NAME,
        state
      );

      if (!lvva?.user) {
        throw new Error("User address ID is required");
      }

      const params = selectProviderState<SwapParamsProviderData>(
        SWAP_PARAMS_PROVIDER_NAME,
        state
      );

      if (!params) {
        throw new Error(
          `Failed to get provider(${SWAP_PARAMS_PROVIDER_NAME}) results`
        );
      }

      if (
        !params.type ||
        !params.tokenIn ||
        !params.tokenOut ||
        !params.amount
      ) {
        throw new Error(state.values.swap);
      }

      const { tokenIn, tokenOut, amount, type } = params;
      const amountUnits = parseUnits(amount, tokenIn.decimals);
      const chain = getChain(lvva.chainId);
      let calldata: CalldataWithDescription[];
      let thought: string;
      let text: string;

      switch (type) {
        case "kyber":
          // todo remove selectSwapRouter
          const swap = selectSwapRouter(tokenIn, tokenOut);

          const { calls, estimation } = await swap(runtime, {
            address: lvva.user.address,
            amountIn: amountUnits,
            chain,
            decimals: tokenIn.decimals,
          });

          calldata = calls;
          thought = `Prepared transaction to swap ${amount} ${tokenIn.symbol} to ${tokenOut.symbol}, display confirmation`;

          text = `Swapping ${amount} ${tokenIn.symbol} to ${tokenOut.symbol}...
${formatEstimation(estimation)}  
Please approve transactions in your wallet.  
`;

          break;
        case "wrap":
          calldata = [
            wrapEth(amountUnits, {
              address: tokenIn.address!,
              decimals: tokenIn.decimals,
            }),
          ];

          thought = `Prepared transaction to wrap ${amount} ${tokenIn.symbol} to ${tokenOut.symbol}, display confirmation`;

          text = `Wrapping ${amount} ${tokenIn.symbol} to ${tokenOut.symbol}...
Please approve transactions in your wallet.
`;
          break;
        case "unwrap":
          calldata = [
            unwrapEth(amountUnits, {
              address: tokenIn.address!,
              decimals: tokenIn.decimals,
            }),
          ];

          thought = `Prepared transaction to unwrap ${amount} ${tokenIn.symbol} to ${tokenOut.symbol}, display confirmation`;

          text = `Unwrapping ${amount} ${tokenIn.symbol} to ${tokenOut.symbol}...
Please approve transactions in your wallet.
`;
          break;
        default:
          throw new Error(`Unknown swap type: ${params.type}`);
      }

      const hash = await service.createCalldata(calldata);

      const json = {
        id: "calls.json",
        url: `/api/calldata?hash=${hash}`,
      };

      const content: Content = {
        thought,
        text,
        actions: ["SWAP_TOKENS"],
        source: message.content.source,
        attachments: [json],
      };

      const responseContent = await rephrase({ runtime, content, state });
      await callback(responseContent);

      return {
        text: `Generated calldata accessible at ${json.url}, generated text: ${responseContent?.text}`,
        values: {
          success: true,
          responded: true,
          lastReply: responseContent.text,
          lastReplyTime: Date.now(),
          thoughtProcess: responseContent?.thought,
        },
        data: {
          actionName: LEVVA_ACTIONS.SWAP_TOKENS,
          response: responseContent,
          thought: responseContent?.thought,
          initialReply: content.text,
          initialThought: content.thought,
          messageGenerated: true,
        },
        success: true,
      };
    } catch (error) {
      logger.error("Error in SWAP_TOKENS action:", error);
      const errorMessage = (error as Error).message ?? "unknown error";
      const thought = `Action failed with error: ${errorMessage}. I should tell the user about the error.`;
      const text = `Failed to swap, reason: ${errorMessage}. Please try again.`;

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

      return {
        text: `Error generating transaction: ${errorMessage}.`,
        values: {
          success: false,
          responded: true,
          error: true,
          lastReply: responseContent.text,
          lastReplyTime: Date.now(),
          thoughtProcess: responseContent?.thought,
        },
        data: {
          actionName: LEVVA_ACTIONS.SWAP_TOKENS,
          error: errorMessage,
        },
        success: false,
        error: error as Error,
      };
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
