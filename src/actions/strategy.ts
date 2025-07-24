import { isHex } from "viem";
import { Action, Content, logger, ModelType } from "@elizaos/core";
import { LEVVA_ACTIONS, LEVVA_SERVICE } from "../constants/enum";
import { IGNORE_REPLY_MODIFIER } from "../constants/prompt";
import { selectLevvaState } from "../providers";
import { LevvaService } from "../services/levva/class";
import { getChain } from "../util/eth/client";
import { rephrase } from "../util/generate";
import { Suggestion } from "./types";
import {
  ExtractedDataForStrategy,
  selectStrategyDataFromMessagesPrompt,
  suggestStrategyAmountPrompt,
  suggestStrategyAssetPrompt,
  suggestStrategyContractPrompt,
  suggestStrategyRiskProfilePrompt,
} from "src/prompts/strategy";
import { StrategyEntry } from "src/services/levva/pool";

const description = [
  "Select optimal earning strategy for user",
  "Initiate deposit for leveraged farming pool for user",
  "Ask user for pool, input token, amount and leverage if not provided",
  IGNORE_REPLY_MODIFIER,
].join(". ");

export const action: Action = {
  name: LEVVA_ACTIONS.SELECT_STRATEGY,
  description,
  similes: [
    LEVVA_ACTIONS.SELECT_STRATEGY,
    "select strategy",
    "SUGGEST_STRATEGY",
    "suggest strategy",
  ],

  validate: async () => {
    return true;
  },

  handler: async (runtime, message, state, options, callback) => {
    try {
      if (!callback) {
        throw new Error("Callback not found, disable action");
      }

      if (!state) {
        throw new Error("State not found, disable action");
      }

      const lvva = selectLevvaState(state);

      if (!lvva) {
        throw new Error("Failed to get lvva provider, disable action");
      }

      const chain = getChain(lvva.chainId);

      if (!lvva.user) {
        throw new Error("Failed to get current user, please connect wallet");
      }

      const address = lvva.user.address;

      const service = runtime.getService<LevvaService>(
        LEVVA_SERVICE.LEVVA_COMMON
      );

      if (!service) {
        throw new Error("Failed to get levva service, disable action");
      }

      const [strategies, portfolio] = await Promise.all([
        service.getStrategies(chain.id),
        service.getWalletAssets({
          address,
          chainId: chain.id,
        }),
      ]);

      let strategiesFormatted = strategies
        .map(
          (v) =>
            `${v.strategy} - Contract address ${v.contractAddress}. ${v.description}. Type: ${v.type}`
        )
        .join("\n");

      const data: ExtractedDataForStrategy = await runtime.useModel(
        ModelType.OBJECT_SMALL,
        {
          prompt: selectStrategyDataFromMessagesPrompt({
            recentMessages: state.values.recentMessages,
            pools: strategiesFormatted,
            knownTokens: state.values.tokens,
            portfolio: service.formatWalletAssets(portfolio),
          }),
        }
      );

      logger.debug(`Strategy selection, known data: ${JSON.stringify(data)}`);

      if (!data.strategy) {
        const result = await rephrase({
          runtime,
          state,
          content: {
            text: `Known strategies:
${strategiesFormatted}
Please select your risk profile`,
            thought:
              "Since user didn't choose risk profile, give him summary and display options.",
            actions: ["SELECT_STRATEGY"],
          },
        });

        await callback(result);
        return true;
      }

      const strategiesByRiskProfile = strategies.filter(
        (s) => s.strategy.toLowerCase() === data.strategy!.toLowerCase()
      );

      if (!strategiesByRiskProfile.length) {
        throw new Error(
          `No strategies for risk profile(${data.strategy}) found`
        );
      }

      let strategy: StrategyEntry | undefined;

      if (strategiesByRiskProfile.length === 1) {
        strategy = strategiesByRiskProfile[0];
      }

      if (!strategy) {
        strategiesFormatted = strategies.map(service.formatStrategy).join("\n");

        if (!data.contract) {
          const result = await rephrase({
            runtime,
            state,
            content: {
              text: `Strategies by risk profile(${data.strategy}):
${strategiesFormatted}
Please select your strategy`,
              thought:
                "Since user didn't choose strategy, give him summary and display options.",
              actions: ["SELECT_STRATEGY"],
            },
          });

          await callback(result);
          return true;
        }

        strategy = strategiesByRiskProfile.find(
          (s) =>
            s.contractAddress.toLowerCase() === data.contract!.toLowerCase()
        );
      }

      if (!strategy) {
        throw new Error(
          `${data.strategy} strategy contract ${data.contract} incorrect`
        );
      }

      const strategyData = await service.getStrategyData(strategy);

      let token: string | undefined =
        strategyData.type === "vault"
          ? strategyData.data.asset
          : strategy.bundler
            ? undefined
            : strategyData.data.baseToken;

      if (!token) {
        if (!data.token) {
          const result = await rephrase({
            runtime,
            state,
            content: {
              text: `Thank you! Contract address ${strategy.contractAddress}. ${strategy.description}. Leverage is x${data.leverage}. I don't know which token to deposit, please help me.`,
              thought:
                "Need to ask user for input token and display strategy info",
              actions: ["SELECT_STRATEGY"],
            },
          });

          await callback(result);
          return true;
        }

        token = data.token;
      }

      const displayToken = isHex(token)
        ? (lvva.byAddress?.[token]?.symbol ?? token)
        : token;

      if (!data.amount) {
        const leverage =
          strategy.type === "pool" ? `Leverage is x${data.leverage}. ` : "";

        const result = await rephrase({
          runtime,
          state,
          content: {
            text: `Contract address ${strategy.contractAddress}. ${strategy.description}. Deposit ${displayToken}. ${leverage}I don't know how much to deposit, please specify the amount.`,
            thought:
              "Need to ask user for input amount and display strategy info",
            actions: ["SELECT_STRATEGY"],
          },
        });

        await callback(result);
        return true;
      }

      if (strategy.type === "pool") {
        const calldata = await service.handlePoolStrategy(
          strategy,
          address,
          token,
          data.amount,
          data.leverage
        );
        const detailedSteps = calldata
          .map((c) => `${c.description}`)
          .join("\n");
        const hash = await service.createCalldata(calldata);

        const json = {
          id: "calls.json",
          url: `/api/calldata?hash=${hash}`,
        };

        const responseContent: Content = {
          thought: `Calldata for strategy is ready need to show summary`,
          text: `${strategy.description}.
I've prepared transactions to deposit ${data.amount} ${token} to pool ${strategy.contractAddress} with x${data.leverage} leverage.
Confirm the following transaction steps:
${detailedSteps}`,
          actions: ["CONFIRM_STRATEGY"],
          attachments: [json],
        };

        await callback(
          await rephrase({ runtime, content: responseContent, state })
        );

        return true;
      } else if (strategy.type === "vault") {
        const calldata = await service.handleVaultStrategy(
          strategy,
          address,
          data.amount
          // todo decide when to wrap tokens
        );

        const detailedSteps = calldata
          .map((c) => `${c.description}`)
          .join("\n");

        const hash = await service.createCalldata(calldata);

        const json = {
          id: "calls.json",
          url: `/api/calldata?hash=${hash}`,
        };

        const responseContent: Content = {
          thought: `Calldata for strategy is ready need to show summary`,
          text: `${strategy.description}.
I've prepared transactions to deposit ${data.amount} ${token} to vault ${strategy.contractAddress}.
Confirm the following transaction steps:
${detailedSteps}`,
          actions: ["CONFIRM_STRATEGY"],
          attachments: [json],
        };

        await callback(
          await rephrase({ runtime, content: responseContent, state })
        );

        return true;
      }

      throw new Error(
        `Strategy ${strategy.type} ${strategy.description} not implemented yet`
      );
    } catch (e) {
      logger.error("Error in SELECT_STRATEGY action:", e);
      // @ts-expect-error fix typing
      const thought = `Action failed with error: ${e.message ?? "unknown"}. I should tell the user about the error.`;
      // @ts-expect-error fix typing
      const text = `Failed to select strategy, reason: ${e.message ?? "unknown"}. Please try again.`;

      const responseContent = await rephrase({
        runtime,
        content: {
          text,
          thought,
          actions: ["SELECT_STRATEGY"],
          source: message.content.source,
        },
        state: state!,
      });

      await callback?.(responseContent);
      return false;
    }
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "What strategy should I choose?",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: `I don't know which pool to use, please choose from the options below:
{{options}}`,
          actions: ["SELECT_STRATEGY"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "I choose pool with address {{poolAddress}}",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Thanks you for this. {{poolDescription}}. Leverage is x{{leverage}}. Now please tell me what token to deposit",
          actions: ["SELECT_STRATEGY"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "I want to deposit {{token}}",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Cool. {{poolDescription}}. Leverage is x{{leverage}}. I don't know how much to deposit, please specify the amount.",
          actions: ["SELECT_STRATEGY"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "I want to double leverage",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Cool. {{poolDescription}}. Leverage is x{{leverage}}. I don't know how much to deposit, please specify the amount.",
          actions: ["SELECT_STRATEGY"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "I want to deposit {{amount}} {{token}}",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Great! {{poolDescription}}. Leverage is x{{leverage}}. Deposit {{amount}} {{token}}. Please sign transactions in your wallet.",
          actions: ["SELECT_STRATEGY"],
        },
      },
    ],
  ],
};

export const suggest: Suggestion[] = [
  {
    name: "strategy-risk-profile",
    description: "First, choose strategy risk profile if no info provided",
    getPrompt: async (runtime, params) => {
      const service = runtime.getService<LevvaService>(
        LEVVA_SERVICE.LEVVA_COMMON
      );

      if (!service) {
        throw new Error("Failed to get levva service");
      }

      const [strategies, assets, availableTokens] = await Promise.all([
        service.getStrategies(params.chainId),
        service.getWalletAssets({
          address: params.address,
          chainId: params.chainId,
        }),
        service.getAvailableTokens({
          chainId: params.chainId,
        }),
      ]);

      return suggestStrategyRiskProfilePrompt({
        strategies: strategies.map(service.formatStrategy).join("\n"),
        decision: params.decision,
        conversation: params.conversation,
        portfolio: service.formatWalletAssets(assets, true),
        availableTokens: availableTokens
          .map((token) => `${token.symbol}(${token.address})`)
          .join(", "),
      });
    },
  },
  {
    name: "strategy-pool",
    description: "Display available pools",
    getPrompt: async (runtime, params) => {
      const service = runtime.getService<LevvaService>(
        LEVVA_SERVICE.LEVVA_COMMON
      );

      if (!service) {
        throw new Error("Failed to get levva service");
      }

      const [strategies, assets, availableTokens] = await Promise.all([
        service.getStrategies(params.chainId).then(async (strategies) => {
          return Promise.all(
            strategies.map(async (strategy) => {
              // fixme implement WHERE ID IN (arr) for cache entries
              const data = await service.getStrategyData(strategy);

              const tokenStr =
                data.type === "pool"
                  ? `Base token: ${data.data.baseToken}, Quote token: ${data.data.quoteToken}`
                  : `Token: ${data.data.asset}`;

              return `${service.formatStrategy(strategy)}. ${tokenStr}`;
            })
          );
        }),
        service.getWalletAssets({
          address: params.address,
          chainId: params.chainId,
        }),
        service.getAvailableTokens({
          chainId: params.chainId,
        }),
      ]);

      return suggestStrategyContractPrompt({
        pools: strategies.join("\n"),
        decision: params.decision,
        conversation: params.conversation,
        portfolio: service.formatWalletAssets(assets, true),
        availableTokens: availableTokens
          .map((token) => `${token.symbol}(${token.address})`)
          .join(", "),
      });
    },
  },
  {
    name: "strategy-asset",
    description: "Display available assets to deposit",
    getPrompt: async (runtime, params) => {
      const service = runtime.getService<LevvaService>(
        LEVVA_SERVICE.LEVVA_COMMON
      );

      if (!service) {
        throw new Error("Failed to get levva service");
      }

      const [strategies, assets, availableTokens] = await Promise.all([
        service.getStrategies(params.chainId).then(async (strategies) => {
          return Promise.all(
            strategies.map(async (strategy) => {
              // fixme implement WHERE ID IN (arr) for cache entries
              const data = await service.getStrategyData(strategy);

              const tokenStr =
                data.type === "pool"
                  ? `Base token: ${data.data.baseToken}, Quote token: ${data.data.quoteToken}`
                  : `Token: ${data.data.asset}`;

              return `${service.formatStrategy(strategy)}. ${tokenStr}`;
            })
          );
        }),
        service.getWalletAssets({
          address: params.address,
          chainId: params.chainId,
        }),
        service.getAvailableTokens({
          chainId: params.chainId,
        }),
      ]);

      return suggestStrategyAssetPrompt({
        pools: strategies.join("\n"),
        decision: params.decision,
        conversation: params.conversation,
        portfolio: service.formatWalletAssets(assets, true),
        availableTokens: availableTokens
          .map((token) => `${token.symbol}(${token.address})`)
          .join(", "),
      });
    },
  },
  {
    name: "strategy-amount",
    description: "Display available amount to deposit",
    getPrompt: async (runtime, params) => {
      const service = runtime.getService<LevvaService>(
        LEVVA_SERVICE.LEVVA_COMMON
      );

      if (!service) {
        throw new Error("Failed to get levva service");
      }

      const [strategies, tokens, portfolio] = await Promise.all([
        service.getStrategies(params.chainId).then(async (strategies) => {
          return Promise.all(
            strategies.map(async (strategy) => {
              // fixme implement WHERE ID IN (arr) for cache entries
              const data = await service.getStrategyData(strategy);

              const tokenStr =
                data.type === "pool"
                  ? `Base token: ${data.data.baseToken}, Quote token: ${data.data.quoteToken}`
                  : `Token: ${data.data.asset}`;

              return `${service.formatStrategy(strategy)}. ${tokenStr}`;
            })
          );
        }),
        service.getAvailableTokens({
          chainId: params.chainId,
        }),
        service.getWalletAssets({
          address: params.address,
          chainId: params.chainId,
        }),
      ]);

      return suggestStrategyAmountPrompt({
        decision: params.decision,
        conversation: params.conversation,
        strategies: strategies.join("\n"),
        portfolio: service.formatWalletAssets(portfolio, true),
        availableTokens: tokens
          .map(
            (token) =>
              `${token.symbol}(${token.address === "0x0000000000000000000000000000000000000000" ? "Native token" : token.address})`
          )
          .join(", "),
      });
    },
  },
];
