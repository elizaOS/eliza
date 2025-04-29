import type { Action, IAgentRuntime, Memory, Provider, State } from '@elizaos/core';
import { addHeader, composeActionExamples, formatActionNames, formatActions } from '@elizaos/core';
import type { IToken } from '../types';

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
export const birdeyeTradePortfolioProvider: Provider = {
  name: 'INTEL_TRADE_PORTFOLIO',
  description: 'A list of your trades',
  dynamic: true,
  //position: -1,
  get: async (runtime: IAgentRuntime, message: Memory, state: State) => {
    console.log('intel:provider - get portfolio');

    // Get all sentiments
    const chains = ['solana', 'base'];

    const portfolioData = (await runtime.getCache<Portfolio[]>('portfolio')) || [];
    const portfolio = portfolioData?.data;
    /*
    wallet: "3nMBmufBUBVnk28sTp3NsrSJsdVGTyLZYmsqpMFaUT9J",
    totalUsd: 87.17431256926011,
    items: [] tokens
    */
    console.log('intel:provider - got portfolio', portfolio);

    // wallet history
    const trades = (await runtime.getCache<TransactionHistory[]>('transaction_history')) || [];
    console.log('intel:provider - got trades', trades.length);
    //console.log('intel:provider - trades', trades)
    /*
    if (!trades.length) {
      logger.warn('intel:provider - no birdeye trade data found');
      return false;
    }
    */

    // trades
    /*
    data: {
      to: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      fee: 105000,
      from: "3nMBmufBUBVnk28sTp3NsrSJsdVGTyLZYmsqpMFaUT9J",
      status: true,
      txHash: "3gSG5b3yBYthiXL7RqTgQUnmJq3E5EFj8SXBEYibHAKgbv3zxDgJyeKpDNEDKaHk4Aahg8vaqBD3r6wQZMQB85nq",
      blockTime: "2025-04-24T01:26:16+00:00",
      mainAction: "createAssociatedAccount",
      blockNumber: 335487585,
      balanceChange: [
        {
          name: "Wrapped SOL",
          amount: 2986597,
          symbol: "SOL",
          address: "So11111111111111111111111111111111111111112",
          logoURI: "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png",
          decimals: 9,
        }, {
          name: "Jupiter",
          owner: "3nMBmufBUBVnk28sTp3NsrSJsdVGTyLZYmsqpMFaUT9J",
          amount: -1040000,
          symbol: "JUP",
          address: "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN",
          logoURI: "https://static.jup.ag/jup/icon.png",
          decimals: 6,
          programId: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
          tokenAccount: "DrJ2wYwH1v8B31oaYtYQn1iLKcMcm62sSobCnVWm25mB",
        }
      ],
      contractLabel: {
        name: "Associated Token Account Program",
        address: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
        metadata: {
          icon: "",
        },
      },
    },
    txHash: "3gSG5b3yBYthiXL7RqTgQUnmJq3E5EFj8SXBEYibHAKgbv3zxDgJyeKpDNEDKaHk4Aahg8vaqBD3r6wQZMQB85nq",
    blockTime: "2025-04-24T01:26:16.000Z",
  },
*/

    //console.log('intel:provider - birdeye token data', tokens)

    let promptInjection =
      '\nYour trades for ' + portfolio.wallet + ' (value: $' + portfolio.totalUsd + 'usd):\n';

    const historyStrings = [];
    try {
      let idx = 1;
      for (const h of trades) {
        console.log(
          'h',
          h.data.status === true,
          !!(h.data && h.data.balanceChange),
          h.data && h.data.balanceChange && h.data.balanceChange.length > 0
        );
        if (
          h.data.status === true &&
          h.data &&
          h.data.balanceChange &&
          h.data.balanceChange.length > 0
        ) {
          console.log('inside');
          const change = h.data.balanceChange[0];
          const action = h.data.mainAction || 'unknown action';
          const amount = change.amount || 0;
          const name = change.name || 'unknown';
          const symbol = change.symbol || '?';
          const time = h.blockTime || 'unknown time';

          const summary = `${action} ${amount} ${name} ($${symbol}) at ${time}`;
          historyStrings.push(summary);
        }
      }
    } catch (e) {
      console.error('e', e);
    }

    // header
    promptInjection += historyStrings.join('\n') + '\n';
    /*
    for (const t: TransactionHistory of trades) {
      if (!sentiment?.occuringTokens?.length) continue;
      sentiments += `ENTRY ${idx}\nTIME: ${sentiment.timeslot}\nTOKEN ANALYSIS:\n`;
      for (const token of sentiment.occuringTokens) {
        sentiments += `${token.token} - Sentiment: ${token.sentiment}\n${token.reason}\n`;
      }
      promptInjection += '\n-------------------\n';
      idx++;
    }
    */
    //promptInjection += '\n' + JSON.stringify(trades) + '\n'

    //console.log('intel:provider - cmc token text', latestTxt)

    const data = {
      portfolio,
      trades,
    };

    const values = {};

    // Combine all text sections
    const text = promptInjection + '\n';

    return {
      data,
      values,
      text,
    };
    return false;
  },
};
