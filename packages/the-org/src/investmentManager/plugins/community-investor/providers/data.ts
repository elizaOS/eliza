import {
  type IAgentRuntime,
  type Memory,
  type Provider,
  type State,
  type UUID,
  composePromptFromState,
  logger,
} from '@elizaos/core';
import { z } from 'zod';
import { formatRecommenderReport } from '../reports';
import type { CommunityInvestorService } from '../tradingService';
import {
  type PositionWithBalance,
  ServiceType,
  type TokenPerformance,
  type RecommenderMetrics as TypesRecommenderMetrics,
  type TokenPerformance as TypesTokenPerformance,
  type Transaction as TypesTransaction,
} from '../types';
// Create a simple formatter module inline if it doesn't exist
// This will be used until a proper formatters.ts file is created
/**
 * Format a Token Performance object into a string with specific details.
 *
 * @param {TypesTokenPerformance} token - The token performance object to format.
 * @returns {string} A formatted string containing the token's chain, address, symbol, price, liquidity, and 24h change.
 */
const formatters = {
  formatTokenPerformance: (token: TypesTokenPerformance): string => {
    return `
        <token>
        Chain: ${token.chain}
        Address: ${token.address}
        Symbol: ${token.symbol}
        Price: $${token.price.toFixed(6)}
        Liquidity: $${token.liquidity.toFixed(2)}
        24h Change: ${token.price24hChange.toFixed(2)}%
        </token>
        `;
  },
};

// Use local formatters until a proper module is created
const { formatTokenPerformance } = formatters;

/**
 * Template for generating a data provider report in HTML format.
 * Includes instructions on how to write the report, links for token addresses, accounts, transactions, and trading pairs.
 * @typedef {string} dataProviderTemplate
 * @property {string} instructions Instructions on writing the report
 * @property {string} token_reports Placeholder for token reports
 * @property {string} positions_summary Summary of positions including current value, realized and unrealized P&L
 * @property {string} entity Entity data placeholder
 * @property {string} global_market_data Global market data placeholder
 */
const dataProviderTemplate = `<data_provider>

<instructions>
Always give a full details report if user ask anything about the positions, tokens, recommenders.
Write the report to be display in telegram.
Always Include links for the token addresses and accounts(wallets, creators) using solscan.
Include links to the tradings pairs using defined.fi.
If generating structured data as part of this report, use XML tags. Example: <example_data><field1>value1</field1></example_data>
Links:

- Token: https://solscan.io/token/[tokenAddress]
- Account: https://solscan.io/account/[accountAddress]
- Tx: https://solscan.io/tx/[txHash]
- Pair: https://www.defined.fi/sol/[pairAddress]

</instructions>

<token_reports>
{{tokenReports}}
</token_reports>

<positions_summary>
Total Current Value: {{totalCurrentValue}}
Total Realized P&L: {{totalRealizedPnL}}
Total Unrealized P&L: {{totalUnrealizedPnL}}
Total P&L: {{totalPnL}}
</positions_summary>

<entity>
{{entity}}
</entity>

<global_market_data>
{{globalMarketData}}
</global_market_data>

</data_provider>`;

/**
 * Extracts actions from a given text that is formatted with <action name="...">...</action> tags.
 *
 * @param {string} text - The text containing the actions to extract.
 * @returns {Array<{ name: string, params: object }>} The array of extracted actions, each containing a name and parameters.
 */
function extractActions(text: string) {
  const regex = /<action name="([^"]+)">([^<]+)<\/action>/g;
  const actions = [];
  const match = regex.exec(text);
  while (match !== null) {
    try {
      const name = match[1];
      const params = JSON.parse(match[2]);
      actions.push({ name, params });
    } catch (error) {
      console.error('Error parsing action:', error);
    }
  }

  return actions;
}

/**
 * Runs a series of actions asynchronously.
 *
 * @param {any[]} actions - The list of actions to run.
 * @param {IAgentRuntime} runtime - The runtime environment for the agent.
 * @param {Memory} message - The memory object for storing data.
 * @param {TypesTokenPerformance[]} tokens - The list of tokens for performance tracking.
 * @param {PositionWithBalance[]} positions - The list of positions with balance information.
 * @param {TypesTransaction[]} transactions - The list of transactions.
 * @returns {Promise<any[]>} A promise that resolves to an array of results from running the actions.
 */

async function runActions(
  actions: any[],
  runtime: IAgentRuntime,
  message: Memory,
  tokens: TypesTokenPerformance[],
  positions: PositionWithBalance[],
  transactions: TypesTransaction[]
) {
  const tradingService = runtime.getService<CommunityInvestorService>(
    ServiceType.COMMUNITY_INVESTOR
  );

  return Promise.all(
    actions.map(async (actionCall) => {
      const action = actions.find((a) => a.name === actionCall.name);
      if (action) {
        const params = action.params.parse(actionCall.params);
        await action.handler(
          { runtime, message, tradingService, tokens, positions, transactions },
          params
        );
      }
    })
  );
}

/**
 * Retrieves data based on the provided runtime and message.
 * @param {IAgentRuntime} runtime - The agent runtime.
 * @param {Memory} message - The message containing the data.
 * @returns {Object} The data, values, and rendered text based on the retrieved information.
 */
export const dataProvider: Provider = {
  name: 'data',
  async get(runtime: IAgentRuntime, message: Memory) {
    try {
      // Extract token addresses from message and recent context
      const messageContent = message.content.text;

      // Extract actions from message content
      const extractedText = messageContent.match(/<o>(.*?)<\/o>/s);
      const actions = extractedText ? extractActions(extractedText[1]) : [];

      // Initialize data
      const tokens: TokenPerformance[] = [];
      const positions: PositionWithBalance[] = [];
      const transactions: TypesTransaction[] = [];

      // Run extracted actions with a safe environment
      if (actions.length > 0) {
        await runActions(
          actions,
          runtime,
          message,
          tokens as TypesTokenPerformance[],
          positions,
          transactions
        );
      }

      // Generate token reports
      const tokenReports = await Promise.all(
        tokens.map(async (token) => formatTokenPerformance(token))
      );

      // Get entity info if message is from a user
      const clientUserId = message.entityId === message.agentId ? '' : message.entityId;
      const entity = await runtime.getEntityById(clientUserId as UUID);
      const tradingService = runtime.getService<CommunityInvestorService>(
        ServiceType.COMMUNITY_INVESTOR
      );

      // Add updatedAt to RecommenderMetrics to make it compatible
      const recommenderMetrics = entity
        ? await tradingService.getRecommenderMetrics(entity.id)
        : undefined;

      const metrics = recommenderMetrics
        ? ({
            ...recommenderMetrics,
            updatedAt: Date.now(), // Add missing updatedAt property
          } as TypesRecommenderMetrics)
        : undefined;

      // Process metrics history if available
      const metricsHistory = entity
        ? await tradingService.getRecommenderMetricsHistory(entity.id)
        : [];

      const typedMetricsHistory = metricsHistory.map((history) => ({
        ...history,
        historyId: history.entityId,
      }));

      const recommenderReport =
        entity && metrics
          ? formatRecommenderReport(entity as any, metrics, typedMetricsHistory)
          : '';

      const totalCurrentValue = '$0.00';
      const totalRealizedPnL = '$0.00';
      const totalUnrealizedPnL = '$0.00';
      const totalPnL = '$0.00';

      const stateData = {
        tokenReports: tokenReports.join('\n'),
        totalCurrentValue,
        totalRealizedPnL,
        totalUnrealizedPnL,
        totalPnL,
        entity: recommenderReport,
        globalMarketData: JSON.stringify({
          prices: {},
          marketCapPercentage: {},
        }),
      };

      const renderedText = composePromptFromState({
        state: stateData as unknown as State,
        template: dataProviderTemplate,
      });

      return {
        data: {
          tokens,
          positions,
          transactions,
          entity,
          metrics,
          metricsHistory: typedMetricsHistory,
        },
        values: {
          tokenReports: tokenReports.join('\n'),
          totalCurrentValue,
          totalRealizedPnL,
          totalUnrealizedPnL,
          totalPnL,
          recommenderReport,
          hasTokens: tokens.length > 0 ? 'true' : 'false',
          hasPositions: positions.length > 0 ? 'true' : 'false',
        },
        text: renderedText,
      };
    } catch (error) {
      logger.error(error);
      return {
        data: {},
        values: {},
        text: '',
      };
    }
  },
};
