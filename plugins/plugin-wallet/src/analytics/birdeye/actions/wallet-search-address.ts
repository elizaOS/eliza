// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import {
  type Action,
  type ActionExample,
  elizaLogger,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  type State,
} from "@elizaos/core";
import { BirdeyeProvider } from "../birdeye";
import type { WalletPortfolioResponse } from "../types/api/wallet";
import type { BaseAddress } from "../types/shared";
import { extractAddresses } from "../utils";

export const walletSearchAddressAction = {
  name: "BIRDEYE_WALLET_SEARCH_ADDRESS",
  similes: [
    "SEARCH_WALLET_ADDRESS",
    "FIND_WALLET_ADDRESS",
    "LOOKUP_WALLET_ADDRESS",
    "CHECK_WALLET_ADDRESS",
    "GET_WALLET_BY_ADDRESS",
    "WALLET_ADDRESS_INFO",
    "WALLET_ADDRESS_LOOKUP",
    "WALLET_ADDRESS_SEARCH",
    "WALLET_ADDRESS_CHECK",
    "WALLET_ADDRESS_DETAILS",
    "WALLET_CONTRACT_SEARCH",
    "WALLET_CONTRACT_LOOKUP",
    "WALLET_CONTRACT_INFO",
    "WALLET_CONTRACT_CHECK",
    "VERIFY_WALLET_ADDRESS",
    "VALIDATE_WALLET_ADDRESS",
    "GET_WALLET_INFO",
    "WALLET_INFO",
    "WALLET_REPORT",
    "WALLET_ANALYSIS",
    "WALLET_OVERVIEW",
    "WALLET_SUMMARY",
    "WALLET_INSIGHT",
    "WALLET_DATA",
    "WALLET_STATS",
    "WALLET_METRICS",
    "WALLET_PROFILE",
    "WALLET_REVIEW",
    "WALLET_CHECK",
    "WALLET_LOOKUP",
    "WALLET_FIND",
    "WALLET_DISCOVER",
    "WALLET_EXPLORE",
  ],
  description:
    "Search for detailed wallet information including portfolio and transaction data by address",
  descriptionCompressed:
    "birdeye wallet portfolio and transaction search by address",
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State,
    _options: Record<string, unknown>,
    callback?: HandlerCallback,
  ) => {
    try {
      const provider = new BirdeyeProvider(runtime);

      // get all wallet addresses from the message
      const addresses = extractAddresses(message.content?.text ?? "");

      elizaLogger.info(
        `Searching Birdeye provider for ${addresses.length} addresses`,
      );

      // for each symbol, do a search in Birdeye. This will return a list of token results that may be amatch to the token symbol.
      const results: WalletPortfolioResponse[] = await Promise.all(
        addresses.map(async ({ address, chain: addressChain }) => {
          // address detection can't distinguish between evm chains, so we currently only do address search on ETH for EVM addresses. Future support will be added for other chains if the user requests it.
          const chain = addressChain === "evm" ? "ethereum" : addressChain;
          return provider.fetchWalletPortfolio(
            {
              wallet: address,
            },
            {
              headers: {
                chain: chain,
              },
            },
          );
        }),
      );

      runtime.logger?.debug(
        `Wallet search results: ${JSON.stringify(results)}`,
      );

      const completeResults = `I performed a search for the wallet addresses you requested and found the following results:\n\n${results
        .map(
          (result, i) =>
            `${formatWalletReport(addresses[i], results.length, i, result)}`,
        )
        .join("\n\n")}`;

      callback?.({ text: completeResults });
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      runtime.logger?.error("Error in searchTokens handler:", errorMessage);
      callback?.({ text: `Error: ${errorMessage}` });
    }
  },
  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const addresses = extractAddresses(message.content?.text ?? "");
    return addresses.length > 0;
  },
  examples: [
    [
      {
        name: "{{name1}}",
        content: {
          text: "Search wallet 0x1234567890abcdef1234567890abcdef12345678",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Searching wallet 0x1234567890abcdef1234567890abcdef12345678",
          actions: ["BIRDEYE_WALLET_SEARCH_ADDRESS"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Look up wallet address HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Looking up wallet address HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH",
          actions: ["WALLET_ADDRESS_LOOKUP"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Check this address: 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Checking this address: 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
          actions: ["CHECK_WALLET_ADDRESS"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Get wallet info for 5yBYpGQRHPz4i5FkVnP9h9VTJBMnwgHRe5L5gw2bwp9q",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Getting wallet info for 5yBYpGQRHPz4i5FkVnP9h9VTJBMnwgHRe5L5gw2bwp9q",
          actions: ["WALLET_INFO"],
        },
      },
    ],
    [
      {
        name: "{{name1}}",
        content: {
          text: "Show me portfolio for 0x3cD751E6b0078Be393132286c442345e5DC49699",
        },
      },
      {
        name: "{{name2}}",
        content: {
          text: "Show me portfolio for 0x3cD751E6b0078Be393132286c442345e5DC49699",
          actions: ["WALLET_OVERVIEW"],
        },
      },
    ],
  ] as ActionExample[][],
} as Action;

// take all the details of the results and present to the user
const formatWalletReport = (
  address: BaseAddress,
  totalResults: number,
  index: number,
  result: WalletPortfolioResponse,
) => {
  const tokens = result.data.items.slice(0, 10) || [];
  const totalValue = tokens.reduce(
    (sum, token) => sum + (token.valueUsd || 0),
    0,
  );

  let header = `Wallet Result ${totalResults > 1 ? `#${index + 1}` : ""}\n`;
  header += `👛 Address ${address.address}*\n`;
  header += `💰 Total Value: $${totalValue.toLocaleString()}\n`;
  header += "🔖 Top Holdings:";
  const tokenList = tokens
    .map(
      (token) =>
        `• $${token?.symbol?.toUpperCase()}: $${token.valueUsd?.toLocaleString()} (${token.uiAmount?.toFixed(4)} tokens)`,
    )
    .join("\n");

  return `${header}\n${tokenList}`;
};
