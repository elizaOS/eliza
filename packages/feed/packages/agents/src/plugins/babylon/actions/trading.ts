/**
 * Trading Actions
 * Actions for trading on prediction and perpetual markets
 */

import type {
  Action,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from '@elizaos/core';
// import { logger } from '../../../shared/logger' // Commented out - not needed
import type { BabylonRuntime } from '../types';

/**
 * Action: Buy Prediction Shares
 * Allows agent to buy YES or NO shares in a prediction market
 */
export const buySharesAction: Action = {
  name: 'BUY_PREDICTION_SHARES',
  description: 'Buy shares in a prediction market',
  similes: [
    'buy shares',
    'purchase prediction',
    'bet on market',
    'buy YES',
    'buy NO',
  ],
  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'Buy 100 YES shares in market market-123' },
      },
      {
        name: '{{agent}}',
        content: {
          text: 'Buying 100 YES shares in market-123...',
          action: 'BUY_PREDICTION_SHARES',
        },
      },
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const content = message.content.text?.toLowerCase() || '';
    return (
      content.includes('buy') &&
      (content.includes('shares') || content.includes('market'))
    );
  },

  handler: (async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback
  ): Promise<void> => {
    const babylonRuntime = runtime as BabylonRuntime;

    if (!babylonRuntime.a2aClient?.isConnected()) {
      if (callback) {
        callback({
          text: 'A2A client not connected. Cannot execute trade.',
          action: 'BUY_PREDICTION_SHARES',
        });
      }
      return;
    }

    // Parse message to extract parameters
    const content = message.content.text || '';
    const marketIdMatch = content.match(/market[:\s-]+([a-zA-Z0-9-]+)/);
    const amountMatch = content.match(
      /(\d+(?:\.\d+)?)\s*(?:shares|dollars|\$)/
    );
    // const _sideMatch = content.match(/\b(YES|NO)\b/i)

    if (!marketIdMatch || !amountMatch) {
      if (callback) {
        callback({
          text: 'Could not parse trade parameters. Please specify market ID and amount.',
          action: 'BUY_PREDICTION_SHARES',
        });
      }
      return;
    }

    const marketId = marketIdMatch[1]!;
    const amount = parseFloat(amountMatch[1]!);
    const sideMatch = content.match(/\b(YES|NO)\b/i);
    const side = (sideMatch?.[1]?.toUpperCase() || 'YES') as 'YES' | 'NO';

    const result = (await babylonRuntime.a2aClient.buyShares(
      marketId,
      side,
      amount
    )) as {
      shares?: number;
      avgPrice?: number;
      cost?: number;
      success?: boolean;
      message?: string;
    };

    if (callback) {
      if (result.success === false) {
        callback({
          text: `Failed to buy shares: ${result.message || 'Unknown error'}`,
          action: 'BUY_PREDICTION_SHARES',
        });
      } else {
        callback({
          text: `Successfully bought ${result.shares || 0} ${side} shares at avg price ${result.avgPrice || 0}. Cost: $${result.cost || amount}`,
          action: 'BUY_PREDICTION_SHARES',
        });
      }
    }
  }) as unknown as Action['handler'],
};

/**
 * Action: Sell Prediction Shares
 * Allows agent to sell shares and close prediction positions
 */
export const sellSharesAction: Action = {
  name: 'SELL_PREDICTION_SHARES',
  description: 'Sell shares in a prediction market',
  similes: [
    'sell shares',
    'close prediction',
    'exit position',
    'sell YES',
    'sell NO',
  ],
  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'Sell 50 YES shares from position pos-123' },
      },
      {
        name: '{{agent}}',
        content: {
          text: 'Selling 50 YES shares...',
          action: 'SELL_PREDICTION_SHARES',
        },
      },
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const content = message.content.text?.toLowerCase() || '';
    return (
      content.includes('sell') &&
      (content.includes('shares') || content.includes('position'))
    );
  },

  handler: (async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback
  ): Promise<void> => {
    const babylonRuntime = runtime as BabylonRuntime;

    if (!babylonRuntime.a2aClient?.isConnected()) {
      if (callback) {
        callback({
          text: 'A2A client not connected. Cannot execute trade.',
          action: 'SELL_PREDICTION_SHARES',
        });
      }
      return;
    }

    // Parse message to extract parameters
    const content = message.content.text || '';
    const positionIdMatch = content.match(/position[:\s-]+([a-zA-Z0-9-]+)/);
    const amountMatch = content.match(/(\d+(?:\.\d+)?)\s*(?:shares)/);

    if (!positionIdMatch || !amountMatch) {
      if (callback) {
        callback({
          text: 'Could not parse trade parameters. Please specify position ID and share amount.',
          action: 'SELL_PREDICTION_SHARES',
        });
      }
      return;
    }

    const positionId = positionIdMatch[1]!;
    const shares = parseFloat(amountMatch[1]!);

    const result = (await babylonRuntime.a2aClient.sellShares(
      positionId,
      shares
    )) as {
      success?: boolean;
      remainingShares?: number;
      proceeds?: number;
      message?: string;
    };

    if (callback) {
      if (result.success === false) {
        callback({
          text: `Failed to sell shares: ${result.message || 'Unknown error'}`,
          action: 'SELL_PREDICTION_SHARES',
        });
      } else {
        callback({
          text: `Successfully sold ${shares} shares. Proceeds: $${result.proceeds || 0}. Remaining: ${result.remainingShares || 0} shares`,
          action: 'SELL_PREDICTION_SHARES',
        });
      }
    }
  }) as unknown as Action['handler'],
};

/**
 * Action: Open Perpetual Position
 * Allows agent to open a leveraged position on a perpetual market
 */
export const openPerpPositionAction: Action = {
  name: 'OPEN_PERP_POSITION',
  description: 'Open a leveraged position on a perpetual market',
  similes: ['open position', 'long', 'short', 'leverage trade', 'perp trade'],
  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'Open a 5x long position on AAPL with $1000' },
      },
      {
        name: '{{agent}}',
        content: {
          text: 'Opening 5x long position on AAPL with $1000...',
          action: 'OPEN_PERP_POSITION',
        },
      },
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const content = message.content.text?.toLowerCase() || '';
    return (
      (content.includes('open') ||
        content.includes('long') ||
        content.includes('short')) &&
      (content.includes('position') || content.includes('perp'))
    );
  },

  handler: (async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback
  ): Promise<void> => {
    const babylonRuntime = runtime as BabylonRuntime;

    if (!babylonRuntime.a2aClient?.isConnected()) {
      if (callback) {
        callback({
          text: 'A2A client not connected. Cannot execute trade.',
          action: 'OPEN_PERP_POSITION',
        });
      }
      return;
    }

    // Parse message to extract parameters
    const content = message.content.text || '';
    const tickerMatch = content.match(/\b([A-Z]{2,5})\b/);
    const amountMatch = content.match(/\$?(\d+(?:\.\d+)?)\s*(?:dollars|\$)?/);
    // const _leverageMatch = content.match(/(\d+)x/)
    // const _sideMatch = content.match(/\b(long|short)\b/i)

    if (!tickerMatch || !amountMatch) {
      if (callback) {
        callback({
          text: 'Could not parse trade parameters. Please specify ticker and amount.',
          action: 'OPEN_PERP_POSITION',
        });
      }
      return;
    }

    const ticker = tickerMatch[1]!;
    const amount = parseFloat(amountMatch[1]!);
    const leverageMatch = content.match(/(\d+)x/);
    const leverage = leverageMatch ? parseInt(leverageMatch[1]!) : 1;
    const sideMatch = content.match(/\b(long|short)\b/i);
    const side = (sideMatch?.[1]?.toLowerCase() || 'long') as 'long' | 'short';

    const result = (await babylonRuntime.a2aClient.openPosition(
      ticker,
      side.toUpperCase() as 'LONG' | 'SHORT',
      amount,
      leverage
    )) as {
      success?: boolean;
      positionId?: string;
      entryPrice?: number;
      message?: string;
    };

    if (callback) {
      if (result.success === false) {
        callback({
          text: `Failed to open position: ${result.message || 'Unknown error'}`,
          action: 'OPEN_PERP_POSITION',
        });
      } else {
        callback({
          text: `Successfully opened ${leverage}x ${side} position on ${ticker}. Entry price: $${result.entryPrice || 0}. Position ID: ${result.positionId || 'unknown'}`,
          action: 'OPEN_PERP_POSITION',
        });
      }
    }
  }) as unknown as Action['handler'],
};

/**
 * Action: Close Perpetual Position
 * Allows agent to close an open perpetual position
 */
export const closePerpPositionAction: Action = {
  name: 'CLOSE_PERP_POSITION',
  description: 'Close an open perpetual position',
  similes: ['close position', 'exit perp', 'close perp', 'exit position'],
  examples: [
    [
      {
        name: '{{user1}}',
        content: { text: 'Close my AAPL position' },
      },
      {
        name: '{{agent}}',
        content: { text: 'Closing position...', action: 'CLOSE_PERP_POSITION' },
      },
    ],
  ],

  validate: async (_runtime: IAgentRuntime, message: Memory) => {
    const content = message.content.text?.toLowerCase() || '';
    return content.includes('close') && content.includes('position');
  },

  handler: (async (
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: unknown,
    callback?: HandlerCallback
  ): Promise<void> => {
    const babylonRuntime = runtime as BabylonRuntime;

    if (!babylonRuntime.a2aClient?.isConnected()) {
      if (callback) {
        callback({
          text: 'A2A client not connected. Cannot close position.',
          action: 'CLOSE_PERP_POSITION',
        });
      }
      return;
    }

    // Parse message to extract ticker or position ID
    const content = message.content.text || '';
    const tickerMatch = content.match(/\b([A-Z]{2,5})\b/);
    const positionIdMatch = content.match(/position[:\s-]+([a-zA-Z0-9-]+)/);

    if (!tickerMatch && !positionIdMatch) {
      if (callback) {
        callback({
          text: 'Could not parse position. Please specify ticker or position ID.',
          action: 'CLOSE_PERP_POSITION',
        });
      }
      return;
    }

    const positionId =
      positionIdMatch?.[1] || (tickerMatch ? `perp-${tickerMatch[1]}` : '');

    if (!positionId) {
      if (callback) {
        callback({
          text: 'Could not determine position ID. Please specify ticker or position ID.',
          action: 'CLOSE_PERP_POSITION',
        });
      }
      return;
    }

    const result = (await babylonRuntime.a2aClient.closePosition(
      positionId
    )) as {
      success?: boolean;
      exitPrice?: number;
      pnl?: number;
      message?: string;
    };

    if (callback) {
      if (result.success === false) {
        callback({
          text: `Failed to close position: ${result.message || 'Unknown error'}`,
          action: 'CLOSE_PERP_POSITION',
        });
      } else {
        callback({
          text: `Successfully closed position. Exit price: $${result.exitPrice || 0}. P&L: ${result.pnl && result.pnl >= 0 ? '+' : ''}$${result.pnl || 0}`,
          action: 'CLOSE_PERP_POSITION',
        });
      }
    }
  }) as unknown as Action['handler'],
};
