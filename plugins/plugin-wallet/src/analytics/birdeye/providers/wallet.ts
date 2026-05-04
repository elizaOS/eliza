// @ts-nocheck — legacy code from absorbed plugins (lp-manager, lpinfo, dexscreener, defi-news, birdeye); strict types pending cleanup
import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import { extractChain } from "../utils";
import { BIRDEYE_SERVICE_NAME } from "../constants";
import { BirdeyeService } from "../service";

/**
 * Provider for Birdeye trending coins
 *
 * @typedef {import('./Provider').Provider} Provider
 * @typedef {import('./Runtime').IAgentRuntime} IAgentRuntime
 * @typedef {import('./Memory').Memory} Memory
 * @typedef {import('./State').State} State
 * @typedef {import('./Action').Action} Action
 *
 * @type {Provider}
 * @property {string} name - The name of the provider
 * @property {string} description - Description of the provider
 * @property {number} position - The position of the provider
 * @property {Function} get - Asynchronous function to get actions that validate for a given message
 *
 * @param {IAgentRuntime} runtime - The agent runtime
 * @param {Memory} message - The message memory
 * @param {State} state - The state of the agent
 * @returns {Object} Object containing data, values, and text related to actions
 */
export const tradePortfolioProvider: Provider = {
  name: "BIRDEYE_TRADE_PORTFOLIO",
  description: "A list of your trades",
  dynamic: true,
  //position: -1,
  get: async (runtime: IAgentRuntime, _message: Memory, _state: State) => {
    try {
      //runtime.logger.debug('birdeye:provider - get portfolio');

      // Get all sentiments
      //const chains = ['solana', 'base'];

      const walletAddr = runtime.getSetting("BIRDEYE_WALLET_ADDR");

      // Guard against undefined wallet address
      if (!walletAddr) {
        runtime.logger?.error("BIRDEYE_WALLET_ADDR setting is not configured");
        return {
          values: {},
          text: "Wallet address is not configured. Please set BIRDEYE_WALLET_ADDR.",
          data: {},
        };
      }

      // Get explicit chain setting if provided
      const explicitChain = runtime.getSetting("BIRDEYE_CHAIN");
      const chain = extractChain(walletAddr, explicitChain);

      // Guard against Birdeye service being unavailable
      const beService = runtime.getService(
        BIRDEYE_SERVICE_NAME,
      ) as BirdeyeService;
      if (
        !beService ||
        typeof beService.fetchWalletTokenList !== "function" ||
        typeof beService.fetchWalletTxList !== "function"
      ) {
        runtime.logger?.error(
          "Birdeye service is unavailable or missing required methods",
        );
        return {
          values: {},
          text: "Birdeye trade history service is currently unavailable. Please try again later.",
          data: {},
        };
      }

      // if this is too slow, enable a task...
      const [portfolio, trades] = await Promise.all([
        beService.fetchWalletTokenList(chain, walletAddr, {
          notOlderThan: 30 * 1000,
        }),
        beService.fetchWalletTxList(chain, walletAddr, {
          notOlderThan: 30 * 1000,
        }),
      ]);

      // Guard against missing portfolio data
      if (!portfolio?.wallet) {
        runtime.logger?.warn("birdeye:provider - no portfolio data found");
        return {
          values: {},
          text: "No portfolio data available.",
          data: {},
        };
      }

      /*
      wallet: "3nMBmufBUBVnk28sTp3NsrSJsdVGTyLZYmsqpMFaUT9J",
      totalUsd: 87.17431256926011,
      items: [] tokens
      */
      //console.log('birdeye:provider - got portfolio', portfolio);

      //runtime.logger.debug('birdeye:provider - got trades', trades.length);
      //console.log('birdeye:provider - trades', trades)
      if (!trades?.length) {
        runtime.logger?.warn("birdeye:provider - no birdeye trade data found");
        return {
          values: {},
          text: "No trade history found for this wallet.",
          data: {},
        };
      }

      // trades
      /*
        }, {
          to: "11111111111111111111111111111111",
          fee: 11727,
          from: "3nMBmufBUBVnk28sTp3NsrSJsdVGTyLZYmsqpMFaUT9J",
          status: true,
          txHash: "4vbkwfFMiPn4BQVePPsAGVPydeFpeVuW9ThojQrf8y9W6CFNDB1n9HikT57RgvuUDnrTC7JtPhQkb7FH8X8CrCHi",
          blockTime: "2025-06-05T00:41:12+00:00",
          mainAction: "send",
          blockNumber: 344672573,
          balanceChange: [
            [Object ...], [Object ...], [Object ...]
          ],
          contractLabel: {
            name: "System Program",
            address: "11111111111111111111111111111111",
            metadata: [Object ...],
          },
          tokenTransfers: [
            [Object ...], [Object ...], [Object ...]
          ],
        }
      */

      //runtime.logger.debug('birdeye:provider - birdeye token data', tokens)

      let promptInjection = `\nYour trades for ${portfolio.wallet} (value: $${portfolio.totalUsd || 0}usd):\n`;

      const historyStrings = [];

      // TODO: Trade detail processing is disabled - the current balance change data structure
      // is incomplete/inconsistent from the API. Re-enable once Birdeye API provides
      // reliable balance change information in transaction responses.

      promptInjection += `${historyStrings.join("\n")}\n`;

      //console.log('birdeye:provider - cmc token text', latestTxt)

      const data = {
        portfolio,
        trades,
      };

      const values = {};

      // Combine all text sections
      const text = `${promptInjection}\n`;

      return {
        data,
        values,
        text,
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      runtime.logger?.error(`Error fetching trade portfolio: ${errorMessage}`);

      // If it's a configuration/validation error (from extractChain), show it to the user
      const isConfigError =
        errorMessage.includes("BIRDEYE_CHAIN") ||
        errorMessage.includes("address") ||
        errorMessage.includes("Invalid");

      return {
        values: {},
        text: isConfigError
          ? errorMessage
          : "Unable to fetch trade history at this time. Please try again later.",
        data: {},
      };
    }
  },
};
