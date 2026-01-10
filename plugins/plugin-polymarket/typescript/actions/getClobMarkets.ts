import {
  type Action,
  type IAgentRuntime,
  type Memory,
  type State,
  type HandlerCallback,
  logger,
  ModelType,
  ActionExample,
} from '@elizaos/core';

import { initializeClobClient } from '../utils/clobClient.js';
import { retrieveAllMarketsTemplate } from '../templates.js';
import { callLLMWithTimeout } from '../utils/llmHelpers.js';

// Trigger words and phrases for CLOB markets action
const CLOB_MARKETS_SIMILES = [
  'CLOB_MARKETS',
  'GET_CLOB_MARKETS',
  'TRADING_MARKETS',
  'TRADEABLE_MARKETS',
  'MARKETS_FOR_TRADING',
  'CLOB_ENABLED',
  'TRADING_ENABLED',
  'ACTIVE_TRADING',
  'CLOB_TRADING',
  'ORDER_BOOK_MARKETS',
  'AVAILABLE_FOR_TRADING',
  'GET_TRADING_MARKETS',
  'SHOW_CLOB_MARKETS',
  'LIST_CLOB_MARKETS',
  'FETCH_CLOB_MARKETS',
  'CLOB_AVAILABLE',
  'TRADING_AVAILABLE',
  'ORDERBOOK_MARKETS',
];

interface ClobMarketsParams {
  category?: string;
  active?: boolean;
  limit?: number;
  error?: string;
}

export const getClobMarkets: Action = {
  name: 'POLYMARKET_GET_CLOB_MARKETS',
  similes: CLOB_MARKETS_SIMILES.map((s) => `POLYMARKET_${s}`),
  description:
    'Get Polymarket markets available for trading via CLOB (Central Limit Order Book) - all markets ready for order placement and execution',

  validate: async (_runtime: IAgentRuntime, _message: Memory) => {
    return true;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    state: State | undefined,
    _options: any,
    callback?: HandlerCallback
  ): Promise<boolean> => {
    try {
      logger.info('[getClobMarkets] Starting CLOB markets retrieval');

      // Initialize CLOB client
      const clobClient = await initializeClobClient(runtime);

      // Try to extract parameters using LLM
      let params: ClobMarketsParams = {};
      try {
        const extractedParams = await callLLMWithTimeout<ClobMarketsParams>(
          runtime,
          state,
          retrieveAllMarketsTemplate,
          'getClobMarkets',
          30000
        );

        if (extractedParams && !extractedParams.error) {
          params = extractedParams;
        }
      } catch (error) {
        logger.warn('[getClobMarkets] LLM extraction failed, using defaults:', error);
        // Continue with empty params (no filters)
      }

      // Call CLOB API to get markets
      logger.info('[getClobMarkets] Fetching CLOB markets from API');
      const marketsResponse = await clobClient.getMarkets('', {
        category: params.category,
        active: params.active,
        limit: params.limit,
      });

      const markets = marketsResponse.data || [];
      const totalCount = marketsResponse.count || 0;
      const nextCursor = marketsResponse.next_cursor;

      logger.info(`[getClobMarkets] Retrieved ${markets.length} CLOB markets`);

      // Format response message
      const responseMessage = formatClobMarketsResponse(markets, totalCount, nextCursor, params);

      if (callback) {
        await callback({
          text: responseMessage,
          content: {
            action: 'clob_markets_retrieved',
            markets: markets,
            count: totalCount,
            next_cursor: nextCursor,
            filters: params,
            timestamp: new Date().toISOString(),
          },
        });
      }

      return true;
    } catch (error) {
      logger.error('[getClobMarkets] Error retrieving CLOB markets:', error);

      const errorMessage = `❌ **Error getting CLOB markets**: ${error instanceof Error ? error.message : 'Unknown error'}

Please check:
• CLOB_API_URL is correctly configured
• Network connectivity is available
• API service is operational`;

      if (callback) {
        await callback({
          text: errorMessage,
          content: {
            action: 'clob_markets_error',
            error: error instanceof Error ? error.message : 'Unknown error',
            timestamp: new Date().toISOString(),
          },
        });
      }

      return false;
    }
  },

  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'Show me markets available for trading via Polymarket' },
      },
      {
        name: '{{user2}}',
        content: {
          text: '📈 **CLOB Markets (Trading Available)**\n\nFound 150 markets ready for trading:\n\n🎯 **Will Donald Trump win the 2024 election?**\n├─ Category: Politics\n├─ Trading: ✅ Active\n├─ Tokens: Yes (0.67) | No (0.33)\n└─ Min Order: $0.01 • Min Tick: $0.01\n\n🎯 **Will Bitcoin reach $100k by end of 2024?**\n├─ Category: Crypto\n├─ Trading: ✅ Active\n├─ Tokens: Yes (0.45) | No (0.55)\n└─ Min Order: $0.01 • Min Tick: $0.01\n\n🎯 **Will Lakers make NBA playoffs?**\n├─ Category: Sports\n├─ Trading: ✅ Active\n├─ Tokens: Yes (0.78) | No (0.22)\n└─ Min Order: $0.01 • Min Tick: $0.01\n\n📊 **Total**: 150 tradeable markets • All CLOB-enabled',
          action: 'POLYMARKET_GET_CLOB_MARKETS',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'GET_CLOB_MARKETS for politics category via Polymarket' },
      },
      {
        name: '{{user2}}',
        content: {
          text: '🗳️ **Politics CLOB Markets**\n\nShowing politics markets available for trading:\n\n📊 **Markets Found**: 25\n📈 **All CLOB-Enabled**: Ready for order placement\n🕒 **Last Updated**: 2024-01-15T10:30:00Z\n\n**Sample Markets:**\n• 2024 Presidential Election (Active)\n• Senate Control predictions (Active)\n• Gubernatorial races (Active)\n• Policy outcome markets (Active)\n\n💡 **Trading Ready**: All markets support limit orders, market orders, and real-time execution via CLOB',
          action: 'POLYMARKET_GET_CLOB_MARKETS',
        },
      },
    ],
    [
      {
        name: '{{user1}}',
        content: { text: 'List active trading markets with limit 10 via Polymarket' },
      },
      {
        name: '{{user2}}',
        content: {
          text: '⚡ **Active CLOB Markets (Limited)**\n\nShowing 10 active markets for trading:\n\n1. **Presidential Election 2024** - Politics\n   └─ Trading: ✅ • Min Order: $0.01\n\n2. **Fed Rate Decision March** - Economics\n   └─ Trading: ✅ • Min Order: $0.01\n\n3. **Super Bowl Winner** - Sports\n   └─ Trading: ✅ • Min Order: $0.01\n\n... and 7 more markets\n\n🔧 **CLOB Features**: Limit orders, market orders, real-time matching\n📋 **Filter Applied**: active=true, limit=10',
          action: 'POLYMARKET_GET_CLOB_MARKETS',
        },
      },
    ],
  ] as ActionExample[][],
};

/**
 * Format CLOB markets response for display
 */
function formatClobMarketsResponse(
  markets: any[],
  totalCount: number,
  nextCursor?: string,
  filters?: ClobMarketsParams
): string {
  if (markets.length === 0) {
    return '📈 **No CLOB markets found**\n\nNo markets are currently available for trading. This might be due to:\n• Applied filters being too restrictive\n• Temporary API issues\n• All markets being paused\n\nTry removing filters or check back later.';
  }

  let response = `📈 **CLOB Markets (Trading Available)**\n\nFound ${markets.length} markets ready for trading:\n\n`;

  // Show first few markets with details
  const displayMarkets = markets.slice(0, 5);

  for (const market of displayMarkets) {
    const tokens = market.tokens || [];

    response += `🎯 **${market.question || 'Unknown Market'}**\n`;
    response += `├─ Category: ${market.category || 'N/A'}\n`;
    response += `├─ Trading: ${market.active ? '✅ Active' : '❌ Inactive'}\n`;

    if (tokens.length >= 2) {
      response += `├─ Tokens: ${tokens[0]?.outcome || 'Yes'} | ${tokens[1]?.outcome || 'No'}\n`;
    }

    // Show trading info
    const minOrder = market.minimum_order_size || '0.01';
    const minTick = market.minimum_tick_size || '0.01';
    response += `└─ Min Order: $${minOrder} • Min Tick: $${minTick}\n`;

    response += '\n';
  }

  if (markets.length > 5) {
    response += `... and ${markets.length - 5} more markets\n\n`;
  }

  // Add summary info
  response += `📊 **Total**: ${totalCount} tradeable markets • All CLOB-enabled`;

  // Add filter info if applied
  if (filters && (filters.category || filters.active !== undefined || filters.limit)) {
    response += '\n🔧 **Filters Applied**: ';
    const filterParts = [];
    if (filters.category) filterParts.push(`category=${filters.category}`);
    if (filters.active !== undefined) filterParts.push(`active=${filters.active}`);
    if (filters.limit) filterParts.push(`limit=${filters.limit}`);
    response += filterParts.join(', ');
  }

  // Add pagination info if available
  if (nextCursor && nextCursor !== 'LTE=') {
    response += `\n📄 **Next**: Use cursor ${nextCursor} for more markets`;
  }

  return response;
}
